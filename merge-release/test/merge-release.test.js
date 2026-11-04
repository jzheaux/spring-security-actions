import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { mergeRelease } from "../src/index.js";
import { git } from "./support/git-repo.js";
import { runAction } from "./support/run-action.js";

// merge-release, with real git: a remote that has the frozen embargoed branch, the active one
// (the frozen one and a fix), and release/7.0.1 (what the workflow builds from the frozen one:
// updates of two dependencies, and the version of the release).
describe("merge-release", () => {
  const bot = (directory) => {
    git(directory, "config", "user.name", "github-actions[bot]");
    git(directory, "config", "user.email", "bot@example.com");
    git(directory, "config", "commit.gpgsign", "false");
  };
  const commit = (directory, message) =>
    git(
      directory,
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-am",
      message,
    );

  /** The remote, and a clone of it on a snapshot branch that starts at the active tip. */
  function world({ fix = true, release = true, edit } = {}) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "merge-release-"));
    const origin = path.join(base, "origin.git");
    git(base, "init", "-q", "--bare", "-b", "main", origin);
    const seed = path.join(base, "seed");
    fs.mkdirSync(seed);
    git(seed, "init", "-q", "-b", "embargoed/frozen/7.0.x");
    bot(seed);
    const write = (file, text) => fs.writeFileSync(path.join(seed, file), text);
    write("gradle.properties", "version=7.0.1-SNAPSHOT\n");
    write(
      "libs.versions.toml",
      '[versions]\nmicrometer = "1.16.7"\nspring-framework = "7.0.9"\n',
    );
    write("A.java", "class A {\n  int x = 1;\n}\n");
    write("B.java", "class B {}\n");
    git(seed, "add", "-A");
    commit(seed, "frozen tip");
    git(seed, "push", "-q", origin, "HEAD:refs/heads/embargoed/frozen/7.0.x");
    const frozen = git(seed, "rev-parse", "HEAD");

    git(seed, "switch", "-q", "-c", "embargoed/active/7.0.x");
    if (fix) {
      write("A.java", "class A {\n  int x = 1; // the CVE fix\n}\n");
      commit(seed, "CVE fix");
    }
    if (edit) {
      edit.active(write, seed, commit);
    }
    git(seed, "push", "-q", origin, "HEAD:refs/heads/embargoed/active/7.0.x");

    if (release) {
      git(seed, "switch", "-q", "-c", "release/7.0.1", frozen);
      write(
        "libs.versions.toml",
        '[versions]\nmicrometer = "1.16.8"\nspring-framework = "7.0.9"\n',
      );
      commit(seed, "Update micrometer to 1.16.8");
      write(
        "libs.versions.toml",
        '[versions]\nmicrometer = "1.16.8"\nspring-framework = "7.0.10"\n',
      );
      commit(seed, "Update spring-framework to 7.0.10");
      write("gradle.properties", "version=7.0.1\n");
      if (edit) {
        edit.release(write, seed, commit);
      }
      commit(seed, "Release 7.0.1");
      git(seed, "push", "-q", origin, "HEAD:refs/heads/release/7.0.1");
    }

    const clone = path.join(base, "clone");
    git(base, "clone", "-q", origin, clone);
    bot(clone);
    git(
      clone,
      "switch",
      "-q",
      "-c",
      "embargoed/7.0.1.1-SNAPSHOT",
      "origin/embargoed/active/7.0.x",
    );
    return { clone, origin, seed };
  }
  const merge = (clone, release = "release/7.0.1") => ({
    merged: mergeRelease({ directory: clone, release }),
  });
  const read = (clone, file) => fs.readFileSync(path.join(clone, file), "utf8");
  const programs = [["src/index.js"], ["dist/index.js"]];
  // git as the workflow has it: with nothing of the developer's configuration
  const bare = {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
  const program = (entry, clone, release = "release/7.0.1") =>
    runAction(entry, { release, path: clone }, bare);

  it("merges the release into the hotfix, with a merge commit that says so, signed off", () => {
    const { clone } = world();
    const before = git(clone, "rev-parse", "HEAD");
    expect(merge(clone).merged).toBe("true");
    expect(git(clone, "log", "-1", "--format=%P").split(" ")).toHaveLength(2);
    expect(git(clone, "log", "-1", "--format=%B").trim()).toBe(
      "Merge release/7.0.1 into embargoed/7.0.1.1-SNAPSHOT\n\nSigned-off-by: github-actions[bot] <bot@example.com>",
    );
    expect(git(clone, "rev-parse", "HEAD^1")).toBe(before);
    expect(git(clone, "rev-parse", "HEAD^2")).toBe(
      git(clone, "rev-parse", "origin/release/7.0.1"),
    );
  });

  it("keeps the fixes of the active embargoed branch, and takes what the release changed", () => {
    const { clone } = world();
    merge(clone);
    expect(read(clone, "A.java")).toContain("the CVE fix");
    expect(read(clone, "libs.versions.toml")).toBe(
      '[versions]\nmicrometer = "1.16.8"\nspring-framework = "7.0.10"\n',
    );
    expect(read(clone, "gradle.properties")).toBe("version=7.0.1\n");
  });

  it("makes a merge commit even if the release could be fast forwarded to", () => {
    // the active embargoed branch has no fix yet: it is the frozen tip, which the release is built on
    const { clone } = world({ fix: false });
    expect(merge(clone).merged).toBe("true");
    expect(git(clone, "log", "-1", "--format=%P").split(" ")).toHaveLength(2);
  });

  it("has nothing to merge if the release is in the hotfix already", () => {
    const { clone } = world();
    merge(clone);
    const after = git(clone, "rev-parse", "HEAD");
    expect(merge(clone).merged).toBe("up-to-date");
    expect(git(clone, "rev-parse", "HEAD")).toBe(after);
  });

  it("merges nothing if there is no release yet", () => {
    const { clone } = world({ release: false });
    const before = git(clone, "rev-parse", "HEAD");
    expect(merge(clone).merged).toBe("false");
    expect(git(clone, "rev-parse", "HEAD")).toBe(before);
  });

  it("merges the release of the remote, and not a branch of that name that is here", () => {
    const { clone } = world();
    // an old release/7.0.1 in the clone, as the checkout of a workflow never has: it must not be used
    git(clone, "branch", "release/7.0.1", "origin/embargoed/frozen/7.0.x");
    merge(clone);
    expect(read(clone, "gradle.properties")).toBe("version=7.0.1\n");
  });

  const bothChanged = {
    active: (write, seed, commit) => {
      write("A.java", "class A {\n  int x = 100; // the CVE fix\n}\n");
      commit(seed, "the fix, differently");
    },
    release: (write, seed) => write("A.java", "class A {\n  int x = 2;\n}\n"),
  };
  const deletedAndChanged = {
    active: (write, seed, commit) => {
      write("B.java", "class B { int fix; }\n");
      commit(seed, "fix B");
    },
    release: (write, seed) => fs.rmSync(path.join(seed, "B.java")),
  };

  it("keeps the active side where both changed the same lines", () => {
    const { clone } = world({ edit: bothChanged });
    expect(merge(clone).merged).toBe("true");
    expect(read(clone, "A.java")).toContain("int x = 100; // the CVE fix");
    expect(git(clone, "status", "--porcelain")).toBe("");
  });

  it("fails, and undoes the merge, for a conflict that the active side cannot settle", () => {
    // the active embargoed branch changed B.java, and the release deleted it
    const { clone } = world({ edit: deletedAndChanged });
    const before = git(clone, "rev-parse", "HEAD");
    expect(() => merge(clone)).toThrow(
      /release\/7\.0\.1 could not be merged into embargoed\/7\.0\.1\.1-SNAPSHOT: B\.java .*Merge release\/7\.0\.1 into the active embargoed branch by hand/,
    );
    expect(git(clone, "rev-parse", "HEAD")).toBe(before);
    expect(git(clone, "status", "--porcelain")).toBe("");
    expect(fs.existsSync(path.join(clone, ".git", "MERGE_HEAD"))).toBe(false);
  });

  it("needs the name of the release", () => {
    const { clone } = world();
    expect(() => merge(clone, "")).toThrow("The input release is required");
  });

  it("fails if git does not know who commits, and merges nothing", () => {
    const { clone } = world();
    git(clone, "config", "--unset", "user.name");
    git(clone, "config", "--unset", "user.email");
    const before = git(clone, "rev-parse", "HEAD");
    const keep = { ...process.env };
    Object.assign(process.env, bare);
    for (const name of [
      "GIT_AUTHOR_NAME",
      "GIT_AUTHOR_EMAIL",
      "GIT_COMMITTER_NAME",
      "GIT_COMMITTER_EMAIL",
      "EMAIL",
    ]) {
      delete process.env[name];
    }
    try {
      expect(() => merge(clone)).toThrow("git does not know who commits");
    } finally {
      process.env = keep;
    }
    expect(git(clone, "rev-parse", "HEAD")).toBe(before);
  });

  // The actions run as programs: the sources, and the bundle that GitHub runs (dist/).
  describe.each(programs)("the program %s", (entry) => {
    it("merges, and writes merged=true", async () => {
      const { clone } = world();
      const result = await program(entry, clone);
      expect(result.code).toBe(0);
      expect(result.outputs).toEqual({ merged: "true" });
      expect(result.stdout).toContain(
        "Merged release/7.0.1 into embargoed/7.0.1.1-SNAPSHOT",
      );
      expect(read(clone, "gradle.properties")).toBe("version=7.0.1\n");
    });

    it("writes merged=up-to-date when the release is in the branch", async () => {
      const { clone } = world();
      await program(entry, clone);
      const again = await program(entry, clone);
      expect(again.outputs).toEqual({ merged: "up-to-date" });
      expect(again.stdout).toContain(
        "is in embargoed/7.0.1.1-SNAPSHOT already",
      );
    });

    it("warns, and writes merged=false, if there is no release yet", async () => {
      const { clone } = world({ release: false });
      const result = await program(entry, clone);
      expect(result.code).toBe(0);
      expect(result.outputs).toEqual({ merged: "false" });
      expect(result.stdout).toContain(
        "::warning title=No release to build the hotfix on::release/7.0.1 does not exist",
      );
    });

    it("warns about the snapshot, not the release, if the branch of the snapshot is missing", async () => {
      const { clone } = world();
      const result = await program(
        entry,
        clone,
        "embargoed/7.0.1-INTERNAL-SNAPSHOT",
      );
      expect(result.code).toBe(0);
      expect(result.outputs).toEqual({ merged: "false" });
      expect(result.stdout).toContain(
        "::warning title=No snapshot to build the hotfix snapshot on::embargoed/7.0.1-INTERNAL-SNAPSHOT does not exist, so the hotfix snapshot is built from the active embargoed branch alone",
      );
    });

    it("says which files both sides changed, and keeps the active side", async () => {
      const { clone } = world({ edit: bothChanged });
      const result = await program(entry, clone);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("::notice title=Changed on both sides::");
      expect(result.stdout).toMatch(/both changed: A\.java\./);
    });

    it("does not say that both sides changed files if they did not", async () => {
      const { clone } = world();
      expect((await program(entry, clone)).stdout).not.toContain(
        "Changed on both sides",
      );
    });

    it("fails with an error that GitHub shows, for a conflict it cannot settle", async () => {
      const { clone } = world({ edit: deletedAndChanged });
      const before = git(clone, "rev-parse", "HEAD");
      const result = await program(entry, clone);
      expect(result.code).toBe(1);
      expect(result.stdout).toContain(
        "::error::release/7.0.1 could not be merged into embargoed/7.0.1.1-SNAPSHOT: B.java",
      );
      expect(git(clone, "rev-parse", "HEAD")).toBe(before);
      expect(git(clone, "status", "--porcelain")).toBe("");
    });
  });
});
