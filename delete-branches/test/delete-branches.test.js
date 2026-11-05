import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { deleteBranches, parseBranches } from "../src/index.js";
import { runAction } from "./support/run-action.js";

const git = (directory, ...args) =>
  execFileSync("git", args, {
    cwd: directory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

/**
 * A repository, owner/repo, served from a directory (GITHUB_SERVER_URL is its file URL),
 * with main as its default branch and the branches given.
 */
function world(branches) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "delete-"));
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
    git(clone, "push", "-q", origin, `main:refs/heads/${branch}`);
  }
  return {
    origin,
    env: { GITHUB_SERVER_URL: `file://${root}` },
    branches: () =>
      git(origin, "for-each-ref", "--format=%(refname:short)", "refs/heads")
        .split("\n")
        .sort(),
  };
}
const repository = "owner/repo";

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

  it("does not take refs/heads/", () => {
    expect(() => parseBranches("refs/heads/a")).toThrow(
      "leave out refs/heads/",
    );
  });

  it.each(["a b", "a..b", "a~1"])("does not take %j", (name) => {
    expect(() => parseBranches(name)).toThrow("is not a valid branch name");
  });

  it("does not take a branch twice", () => {
    expect(() => parseBranches("a\nb\na")).toThrow("in the input twice");
  });
});

describe("deleteBranches", () => {
  const run = (w, branches) => {
    process.env.GITHUB_SERVER_URL = w.env.GITHUB_SERVER_URL;
    return deleteBranches({ repository, branches, token: "secret" });
  };

  it("deletes the branches", () => {
    const w = world(["release/1.0", "embargoed/1.0", "keep"]);
    const result = run(w, ["release/1.0", "embargoed/1.0"]);
    expect(result).toEqual({
      rows: [
        { branch: "release/1.0", result: "deleted" },
        { branch: "embargoed/1.0", result: "deleted" },
      ],
    });
    expect(w.branches()).toEqual(["keep", "main"]);
  });

  it("deletes nothing if a branch does not exist", () => {
    const w = world(["a", "b"]);
    const { rows, problem } = run(w, ["a", "nope", "b"]);
    expect(rows).toEqual([
      { branch: "a", result: "not deleted" },
      { branch: "nope", result: "not found" },
      { branch: "b", result: "not deleted" },
    ]);
    expect(problem).toBe("nope does not exist in owner/repo");
    expect(w.branches()).toEqual(["a", "b", "main"]);
  });

  it("deletes nothing if a branch is the default branch", () => {
    const w = world(["a"]);
    const { rows, problem } = run(w, ["a", "main"]);
    expect(rows[1]).toEqual({ branch: "main", result: "default branch" });
    expect(problem).toContain("main is the default branch");
    expect(w.branches()).toEqual(["a", "main"]);
  });

  it("deletes nothing if the remote refuses one of the branches", () => {
    const w = world(["a", "protected"]);
    const hook = path.join(w.origin, "hooks", "pre-receive");
    fs.writeFileSync(
      hook,
      '#!/bin/sh\nwhile read old new ref; do\n  if [ "$ref" = refs/heads/protected ]; then echo "protected branch" >&2; exit 1; fi\ndone\n',
      { mode: 0o755 },
    );
    const { rows, problem } = run(w, ["a", "protected"]);
    expect(rows.map((r) => r.result)).toEqual(["not deleted", "not deleted"]);
    expect(problem).toContain("The push was refused");
    expect(problem).toContain("protected branch");
    expect(w.branches()).toEqual(["a", "main", "protected"]);
  });

  it("is not for a repository that is not owner/repo", () => {
    expect(() =>
      deleteBranches({ repository: "repo", branches: ["a"], token: "t" }),
    ).toThrow("expected owner/repo");
  });
});

describe("the action", () => {
  const inputs = (branches) => ({ repository, branches, token: "secret" });

  it("deletes the branches, says so, and outputs them", async () => {
    const w = world(["a", "b", "c"]);
    const summary = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "s-")),
      "s",
    );
    const result = await runAction("src/index.js", inputs("a\nb"), {
      ...w.env,
      GITHUB_STEP_SUMMARY: summary,
    });
    expect(result.code).toBe(0);
    expect(result.outputs.deleted).toBe("a\nb");
    expect(fs.readFileSync(summary, "utf8")).toContain(
      "2 branches deleted, atomically",
    );
    expect(w.branches()).toEqual(["c", "main"]);
  });

  it("fails, with a summary, and deletes nothing if a branch is missing", async () => {
    const w = world(["a"]);
    const summary = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "s-")),
      "s",
    );
    const result = await runAction("src/index.js", inputs("a\nnope"), {
      ...w.env,
      GITHUB_STEP_SUMMARY: summary,
    });
    expect(result.code).not.toBe(0);
    expect(result.stdout).toContain("Nothing was deleted: nope does not exist");
    expect(fs.readFileSync(summary, "utf8")).toContain(
      "| `nope` | not found |",
    );
    expect(result.outputs.deleted).toBeUndefined();
    expect(w.branches()).toEqual(["a", "main"]);
  });

  it("does not print the token, even when git fails", async () => {
    const result = await runAction("src/index.js", inputs("a"), {
      GITHUB_SERVER_URL: "file:///nonexistent",
    });
    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("git ls-remote failed");
    const shown = (result.stdout + result.stderr).replace(
      "::add-mask::secret",
      "",
    );
    expect(shown).not.toContain("secret");
    expect(shown).not.toContain(
      Buffer.from("x-access-token:secret").toString("base64"),
    );
  });
});
