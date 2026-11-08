import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { exportMerges } from "../src/index.js";
import { runAction } from "./support/run-action.js";

const git = (directory, ...args) =>
  execFileSync("git", args, {
    cwd: directory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

/**
 * The clone that merge-tag leaves, made by hand: work refs of an OSS branch, 7.1.x (with a
 * merge made on it) and of a commercial one, embargoed/active/7.1.x (not changed), and the
 * merge file and the plan that describe them.
 */
function world({ ref } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "export-"));
  const clone = path.join(root, "clone");
  git(root, "init", "-q", "-b", "main", clone);
  git(clone, "config", "user.name", "Alice");
  git(clone, "config", "user.email", "alice@example.com");
  git(clone, "config", "commit.gpgsign", "false");
  const commit = (file, message) => {
    fs.writeFileSync(path.join(clone, file), `${message}\n`);
    git(clone, "add", "-A");
    git(clone, "commit", "-q", "-m", message);
    return git(clone, "rev-parse", "HEAD");
  };
  const base = commit("base.txt", "Base");
  git(clone, "switch", "-q", "-c", "side");
  commit("fix.txt", "The fix");
  git(clone, "switch", "-q", "main");
  const before = base;
  git(
    clone,
    "merge",
    "-q",
    "--no-ff",
    "-m",
    "Merge tag '7.1.3' into 7.1.x",
    "side",
  );
  const after = git(clone, "rev-parse", "HEAD");
  git(clone, "update-ref", "refs/post-publish/oss/7.1.x", after);
  git(
    clone,
    "update-ref",
    "refs/post-publish/commercial/embargoed/active/7.1.x",
    base,
  );
  git(clone, "reset", "-q", "--hard", base);
  const merge = {
    kind: "oss",
    tag: "7.1.3",
    ref: ref ?? null,
    branches: [
      {
        repository: "oss",
        branch: "7.1.x",
        ref: "refs/post-publish/oss/7.1.x",
        before,
        after,
        changed: true,
      },
      {
        repository: "commercial",
        branch: "embargoed/active/7.1.x",
        ref: "refs/post-publish/commercial/embargoed/active/7.1.x",
        before: base,
        after: base,
        changed: false,
      },
    ],
  };
  const plan = {
    tag: "7.1.3",
    ossRepository: "owner/spring-security",
    commercialRepository: "owner/spring-security-commercial",
  };
  return { root, clone, merge, plan, before, after, base };
}

const heads = (directory) =>
  git(directory, "for-each-ref", "--format=%(refname:short)", "refs/heads")
    .split("\n")
    .sort();

describe("exportMerges", () => {
  it("makes a repository with only the merged branches, named as in their repositories", () => {
    const w = world();
    const target = path.join(w.root, "export");
    const { branches } = exportMerges({
      directory: w.clone,
      merge: w.merge,
      plan: w.plan,
      target,
      dryRun: true,
    });
    expect(heads(target)).toEqual(["7.1.x", "embargoed/active/7.1.x"]);
    expect(git(target, "rev-parse", "7.1.x")).toBe(w.after);
    expect(git(target, "rev-parse", "embargoed/active/7.1.x")).toBe(w.base);
    expect(branches.map((b) => [b.repository, b.branch, b.changed])).toEqual([
      ["oss", "7.1.x", true],
      ["commercial", "embargoed/active/7.1.x", false],
    ]);
    // the commit before is in it, so that the diff can be made
    expect(git(target, "diff", "--stat", w.before, "7.1.x")).toContain(
      "fix.txt",
    );
    expect(git(target, "symbolic-ref", "HEAD")).toBe("refs/heads/7.1.x");
  });

  it("has a README with the table, how to look, and no remote and no push", () => {
    const w = world();
    const target = path.join(w.root, "export");
    exportMerges({
      directory: w.clone,
      merge: w.merge,
      plan: w.plan,
      target,
      dryRun: true,
    });
    const readme = fs.readFileSync(path.join(target, "README.md"), "utf8");
    expect(readme).toContain("# Merged branches of 7.1.3 (dry run)");
    expect(readme).toContain(
      `| owner/spring-security | \`7.1.x\` | ${w.after.slice(0, 7)} | ${w.before.slice(0, 7)} |`,
    );
    expect(readme).toContain(
      "| owner/spring-security-commercial | `embargoed/active/7.1.x` | " +
        `${w.base.slice(0, 7)} | up to date |`,
    );
    expect(readme).toContain("git log --graph --oneline 7.1.x");
    expect(readme).toContain(`git diff ${w.before.slice(0, 7)} 7.1.x`);
    expect(readme).not.toMatch(/git push/);
    expect(git(target, "remote")).toBe("");
  });

  it("says which ref stands in for the tag", () => {
    const w = world({
      ref: { name: "release/7.1.3", sha: "fc6c49669dfe4c8aa" },
    });
    const target = path.join(w.root, "export");
    exportMerges({
      directory: w.clone,
      merge: w.merge,
      plan: w.plan,
      target,
      dryRun: true,
    });
    expect(fs.readFileSync(path.join(target, "README.md"), "utf8")).toContain(
      "The ref `release/7.1.3` (fc6c496) stands in for the tag `7.1.3`, which does not exist yet.",
    );
  });

  it("exports nothing when no branch was merged", () => {
    const w = world();
    const target = path.join(w.root, "export");
    expect(
      exportMerges({
        directory: w.clone,
        merge: { ...w.merge, branches: [] },
        plan: w.plan,
        target,
      }),
    ).toEqual({ branches: [] });
    expect(fs.existsSync(target)).toBe(false);
  });

  it("fails if the directory is not empty, or a branch is in two repositories", () => {
    const w = world();
    const target = path.join(w.root, "export");
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "x"), "x");
    expect(() =>
      exportMerges({
        directory: w.clone,
        merge: w.merge,
        plan: w.plan,
        target,
      }),
    ).toThrow("exists, and is not empty");
    const twice = {
      ...w.merge,
      branches: [
        w.merge.branches[0],
        { ...w.merge.branches[1], branch: "7.1.x" },
      ],
    };
    expect(() =>
      exportMerges({
        directory: w.clone,
        merge: twice,
        plan: w.plan,
        target: path.join(w.root, "other"),
      }),
    ).toThrow("is in the merges of two repositories");
  });
});

describe("the action", () => {
  it("exports from the files, with outputs and a summary", async () => {
    const w = world();
    const mergeFile = path.join(w.root, "merge.json");
    const planFile = path.join(w.root, "plan.json");
    fs.writeFileSync(mergeFile, JSON.stringify(w.merge));
    fs.writeFileSync(planFile, JSON.stringify(w.plan));
    const summary = path.join(w.root, "summary.md");
    const directory = path.join(w.root, "out");
    const result = await runAction(
      "src/index.js",
      {
        "merge-file": mergeFile,
        "plan-file": planFile,
        directory,
        path: w.clone,
        "dry-run": "true",
        name: "merged-branches-7.1.3",
      },
      { GITHUB_STEP_SUMMARY: summary },
    );
    expect(result.code).toBe(0);
    expect(result.outputs).toMatchObject({
      directory,
      name: "merged-branches-7.1.3",
      count: "2",
    });
    expect(heads(directory)).toEqual(["7.1.x", "embargoed/active/7.1.x"]);
    const text = fs.readFileSync(summary, "utf8");
    expect(text).toContain("### Merged branches of 7.1.3 (dry run)");
    expect(text).toContain(
      "Download the artifact `merged-branches-7.1.3`, unzip it, and from inside it, for example:",
    );
  });
});
