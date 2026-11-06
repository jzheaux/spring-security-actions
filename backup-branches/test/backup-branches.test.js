import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  backupBranches,
  parseBranches,
  restoreCommands,
} from "../src/index.js";
import { runAction } from "./support/run-action.js";

const git = (directory, ...args) =>
  execFileSync("git", args, {
    cwd: directory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

/**
 * A repository, owner/repo, served from a directory (GITHUB_SERVER_URL is its file URL),
 * with main as its default branch, and a branch of its own commit for each name given
 * (the commit has a file of the name of the branch, so they all differ).
 */
function world(branches) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "backup-"));
  const origin = path.join(root, "owner", "repo.git");
  fs.mkdirSync(path.dirname(origin), { recursive: true });
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  const clone = path.join(root, "clone");
  git(root, "init", "-q", "-b", "main", clone);
  git(clone, "config", "user.name", "Alice");
  git(clone, "config", "user.email", "alice@example.com");
  git(clone, "config", "commit.gpgsign", "false");
  git(clone, "commit", "-q", "--allow-empty", "-m", "Initial commit");
  git(clone, "push", "-q", origin, "main");
  for (const branch of branches) {
    git(clone, "switch", "-q", "-c", branch, "main");
    fs.mkdirSync(path.dirname(path.join(clone, branch)), { recursive: true });
    fs.writeFileSync(path.join(clone, branch), `${branch}\n`);
    git(clone, "add", "-A");
    git(clone, "commit", "-q", "-m", `Work on ${branch}`);
    git(clone, "push", "-q", origin, `${branch}:refs/heads/${branch}`);
    git(clone, "switch", "-q", "main");
  }
  return {
    origin,
    env: { GITHUB_SERVER_URL: `file://${root}` },
    sha: (branch) => git(origin, "rev-parse", `refs/heads/${branch}`),
    branches: () =>
      git(origin, "for-each-ref", "--format=%(refname:short)", "refs/heads")
        .split("\n")
        .sort(),
  };
}
const repository = "owner/repo";
const target = () =>
  path.join(fs.mkdtempSync(path.join(os.tmpdir(), "target-")), "backup");

describe("parseBranches", () => {
  it("is a branch for every line", () => {
    expect(parseBranches("release/1.0\n\n  embargoed/x  \n")).toEqual([
      "release/1.0",
      "embargoed/x",
    ]);
  });

  it.each(["", "  \n", undefined])("needs a branch: %j", (text) => {
    expect(() => parseBranches(text)).toThrow("The input branches is required");
  });

  it("does not take refs/heads/, a bad name or a branch twice", () => {
    expect(() => parseBranches("refs/heads/a")).toThrow(
      "leave out refs/heads/",
    );
    expect(() => parseBranches("a b")).toThrow("is not a valid branch name");
    expect(() => parseBranches("a\na")).toThrow("in the input twice");
  });
});

describe("backupBranches", () => {
  const backup = (w, branches, directory = target()) => {
    process.env.GITHUB_SERVER_URL = w.env.GITHUB_SERVER_URL;
    return {
      directory,
      ...backupBranches({ repository, branches, token: "secret", directory }),
    };
  };

  it("makes a clone with only the branches, at their commits, with their history", () => {
    const w = world(["release/1.0", "embargoed/1.0-SNAPSHOT", "other"]);
    const { directory, backedUp, missing } = backup(w, [
      "release/1.0",
      "embargoed/1.0-SNAPSHOT",
    ]);
    expect(missing).toEqual([]);
    expect(backedUp).toEqual([
      { branch: "release/1.0", commit: w.sha("release/1.0") },
      {
        branch: "embargoed/1.0-SNAPSHOT",
        commit: w.sha("embargoed/1.0-SNAPSHOT"),
      },
    ]);
    const local = git(
      directory,
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/heads",
    )
      .split("\n")
      .sort();
    expect(local).toEqual(["embargoed/1.0-SNAPSHOT", "release/1.0"]);
    expect(git(directory, "log", "--format=%s", "release/1.0")).toBe(
      "Work on release/1.0\nInitial commit",
    );
  });

  it("has no credentials in any file of the backup", () => {
    const w = world(["a"]);
    const { directory } = backup(w, ["a"]);
    const hits = (needle) => {
      try {
        return execFileSync("grep", ["-rIl", "--", needle, directory], {
          encoding: "utf8",
        }).trim();
      } catch {
        return "";
      }
    };
    expect(hits("secret")).toBe("");
    expect(hits(Buffer.from("x-access-token:secret").toString("base64"))).toBe(
      "",
    );
    expect(git(directory, "config", "--list")).not.toContain("extraheader");
  });

  it("skips a branch that does not exist", () => {
    const w = world(["a"]);
    const { backedUp, missing } = backup(w, ["a", "nope"]);
    expect(backedUp.map((b) => b.branch)).toEqual(["a"]);
    expect(missing).toEqual(["nope"]);
  });

  it("makes nothing when no branch exists", () => {
    const w = world([]);
    const directory = target();
    const result = backup(w, ["nope"], directory);
    expect(result.backedUp).toEqual([]);
    expect(fs.existsSync(directory)).toBe(false);
  });

  it("refuses a directory that has something in it", () => {
    const w = world(["a"]);
    const directory = target();
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "file"), "x");
    expect(() => backup(w, ["a"], directory)).toThrow(
      "exists, and is not empty",
    );
  });

  it("has commands that put a deleted branch back, at the same commit", () => {
    const w = world(["release/1.0", "keep"]);
    const { directory, backedUp } = backup(w, ["release/1.0"]);
    const before = w.sha("release/1.0");
    git(w.origin, "update-ref", "-d", "refs/heads/release/1.0");
    expect(w.branches()).toEqual(["keep", "main"]);
    for (const command of restoreCommands(repository, backedUp)) {
      const [, ...args] = command.split(" ");
      git(directory, ...args);
    }
    expect(w.sha("release/1.0")).toBe(before);
    const restore = fs.readFileSync(path.join(directory, "RESTORE.md"), "utf8");
    expect(restore).toContain(restoreCommands(repository, backedUp)[0]);
  });
});

describe("the action", () => {
  const inputs = (branches, directory) => ({
    repository,
    branches,
    name: "restore-deleted-branches-1.0",
    token: "secret",
    ...(directory && { directory }),
  });

  it("backs up, outputs, and says the commands in the summary", async () => {
    const w = world(["a", "b"]);
    const summary = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "s-")),
      "s",
    );
    const directory = target();
    const result = await runAction(
      "src/index.js",
      inputs("a\nb\nnope", directory),
      {
        ...w.env,
        GITHUB_STEP_SUMMARY: summary,
      },
    );
    expect(result.code).toBe(0);
    expect(result.outputs).toEqual({
      directory,
      name: "restore-deleted-branches-1.0",
      count: "2",
      branches: `a=${w.sha("a")}\nb=${w.sha("b")}`,
      missing: "nope",
    });
    const text = fs.readFileSync(summary, "utf8");
    expect(text).toContain(
      "### Back-up of the branches to delete in owner/repo",
    );
    expect(text).toContain(`| \`a\` | ${w.sha("a").slice(0, 7)} |`);
    expect(text).toContain(
      "Download the artifact `restore-deleted-branches-1.0`",
    );
    expect(text).toContain(`${w.sha("a")}:refs/heads/a`);
    expect(text).toContain("Not found: `nope`.");
  });

  it("has a count of 0 when there is nothing to back up", async () => {
    const w = world([]);
    const result = await runAction(
      "src/index.js",
      inputs("nope", target()),
      w.env,
    );
    expect(result.code).toBe(0);
    expect(result.outputs.count).toBe("0");
  });

  it("does not print the token, even when git fails", async () => {
    const result = await runAction("src/index.js", inputs("a", target()), {
      GITHUB_SERVER_URL: "file:///nonexistent",
    });
    expect(result.code).not.toBe(0);
    const shown = (result.stdout + result.stderr).replace(
      "::add-mask::secret",
      "",
    );
    expect(shown).toContain("git ls-remote failed");
    expect(shown).not.toContain("secret");
  });
});
