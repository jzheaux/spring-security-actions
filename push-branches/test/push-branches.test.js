import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseBranches, pushBranches } from "../src/index.js";
import { createRepo, git } from "./support/git-repo.js";
import { runAction } from "./support/run-action.js";

/** A clone with a remote, and two local branches with one and two commits on main. */
function world() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "push-"));
  const origin = path.join(base, "origin.git");
  git(base, "init", "-q", "--bare", "-b", "main", origin);
  const clone = createRepo({ a: "1" });
  git(clone, "remote", "add", "origin", origin);
  git(clone, "push", "-q", "origin", "main");
  const main = git(clone, "rev-parse", "HEAD");
  const commit = (message) =>
    git(clone, "commit", "-q", "--allow-empty", "-m", message);
  git(clone, "switch", "-q", "-c", "release/1.0", main);
  commit("one");
  git(clone, "switch", "-q", "-c", "embargoed/1.0-SNAPSHOT", main);
  commit("one");
  commit("two");
  return { clone, origin, main };
}
const remote = (origin, branch) => {
  try {
    return git(origin, "rev-parse", `refs/heads/${branch}`);
  } catch {
    return undefined;
  }
};
const branches = [
  { branch: "release/1.0", version: "1.0" },
  { branch: "embargoed/1.0-SNAPSHOT", version: "1.0-SNAPSHOT" },
];

describe("parseBranches", () => {
  it("is a branch and a version for every line", () => {
    expect(
      parseBranches("release/1.0=1.0\n\n  embargoed/x=1.0-SNAPSHOT  \n"),
    ).toEqual([
      { branch: "release/1.0", version: "1.0" },
      { branch: "embargoed/x", version: "1.0-SNAPSHOT" },
    ]);
  });

  it("splits at the last =", () => {
    expect(parseBranches("a=b=1.0")).toEqual([
      { branch: "a=b", version: "1.0" },
    ]);
  });

  it.each(["", "  \n", undefined])("needs a branch: %j", (text) => {
    expect(() => parseBranches(text)).toThrow("The input branches is required");
  });

  it.each(["release", "=1.0", "release="])("does not take %j", (line) => {
    expect(() => parseBranches(line)).toThrow("is not branch=version");
  });
});

describe("pushBranches", () => {
  it("pushes the branches, and counts their commits on the base", () => {
    const { clone, origin, main } = world();
    const pushed = pushBranches({ directory: clone, branches, base: main });
    expect(pushed).toEqual([
      { branch: "release/1.0", version: "1.0", commits: 1 },
      {
        branch: "embargoed/1.0-SNAPSHOT",
        version: "1.0-SNAPSHOT",
        commits: 2,
      },
    ]);
    expect(remote(origin, "release/1.0")).toBe(
      git(clone, "rev-parse", "release/1.0"),
    );
    expect(remote(origin, "embargoed/1.0-SNAPSHOT")).toBe(
      git(clone, "rev-parse", "embargoed/1.0-SNAPSHOT"),
    );
  });

  it("forces: a branch that was built again replaces the old one", () => {
    const { clone, origin, main } = world();
    pushBranches({ directory: clone, branches, base: main });
    git(clone, "switch", "-q", "-C", "release/1.0", main);
    git(clone, "commit", "-q", "--allow-empty", "-m", "another one");
    pushBranches({ directory: clone, branches, base: main });
    expect(remote(origin, "release/1.0")).toBe(
      git(clone, "rev-parse", "release/1.0"),
    );
  });

  it("pushes none if one cannot be pushed (atomic)", () => {
    const { clone, origin, main } = world();
    // a hook of the remote that refuses one of the branches
    const hook = path.join(origin, "hooks", "update");
    fs.writeFileSync(
      hook,
      '#!/bin/sh\n[ "$1" = refs/heads/embargoed/1.0-SNAPSHOT ] && exit 1\nexit 0\n',
    );
    fs.chmodSync(hook, 0o755);
    expect(() =>
      pushBranches({ directory: clone, branches, base: main }),
    ).toThrow("git push");
    expect(remote(origin, "release/1.0")).toBeUndefined();
    expect(remote(origin, "embargoed/1.0-SNAPSHOT")).toBeUndefined();
  });

  it("fails for a branch that does not exist, and pushes nothing", () => {
    const { clone, origin, main } = world();
    expect(() =>
      pushBranches({
        directory: clone,
        branches: [...branches, { branch: "nothing", version: "1" }],
        base: main,
      }),
    ).toThrow("git rev-list");
    expect(remote(origin, "release/1.0")).toBeUndefined();
  });
});

describe.each([["src/index.js"], ["dist/index.js"]])(
  "the program %s",
  (entry) => {
    it("pushes the branches, and tells in the summary what it created", async () => {
      const { clone, origin, main } = world();
      const summary = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), "summary-")),
        "summary.md",
      );
      const result = await runAction(
        entry,
        {
          branches: "release/1.0=1.0\nembargoed/1.0-SNAPSHOT=1.0-SNAPSHOT",
          base: main,
          path: clone,
          title: "embargoed/frozen/1.0.x",
        },
        { GITHUB_STEP_SUMMARY: summary },
      );
      expect(result.code).toBe(0);
      expect(remote(origin, "release/1.0")).toBeDefined();
      const text = fs.readFileSync(summary, "utf8");
      expect(text).toContain(
        "This push creates two branches that are used for releasing 1.0: `embargoed/1.0-SNAPSHOT`, the snapshot, and `release/1.0`, the release.",
      );
      expect(text).toContain(
        [
          "| Branch | Version | Not in OSS |",
          "| --- | --- | --- |",
          "| `embargoed/1.0-SNAPSHOT` | 1.0-SNAPSHOT | 2 |",
          "| `release/1.0` | 1.0 | 1 |",
        ].join("\n"),
      );
    });

    it("takes the pushed commit and the title of the workflow", async () => {
      const { clone, main } = world();
      const result = await runAction(
        entry,
        { branches: "release/1.0=1.0", path: clone },
        { GITHUB_SHA: main, GITHUB_REF_NAME: "embargoed/frozen/x" },
      );
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("### embargoed/frozen/x");
    });

    it("fails with an error that GitHub shows, and pushes nothing", async () => {
      const { clone, origin, main } = world();
      const result = await runAction(entry, {
        branches: "release/1.0=1.0\nnothing=1",
        base: main,
        path: clone,
      });
      expect(result.code).toBe(1);
      expect(result.stdout).toContain("::error::git rev-list");
      expect(remote(origin, "release/1.0")).toBeUndefined();
    });

    it("needs the pushed commit", async () => {
      const result = await runAction(entry, { branches: "a=1" });
      expect(result.code).toBe(1);
      expect(result.stdout).toContain("The input base is required");
    });
  },
);
