import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkNothingCommercialInOss,
  pushFreeze,
  refspecsOf,
} from "../src/index.js";
import { createFixture, git } from "./support/freeze-fixture.js";

const OSS = "refs/freeze/oss/7.0.x";
const FROZEN = "refs/freeze/commercial/embargoed/frozen/7.0.x";

/**
 * What the apply step leaves, made by hand for one generation: a version commit on the OSS
 * branch 7.0.x, and the commercial frozen branch with that OSS branch merged down.
 */
function simulate(options, { bump } = {}) {
  const fixture = createFixture(options);
  const dir = fixture.work;
  git(dir, "remote", "add", "oss", fixture.oss);
  git(
    dir,
    "fetch",
    "-q",
    "--no-tags",
    "oss",
    "+refs/heads/*:refs/remotes/oss/*",
  );
  git(dir, "update-ref", OSS, "refs/remotes/oss/7.0.x");
  git(dir, "update-ref", FROZEN, "refs/remotes/origin/embargoed/frozen/7.0.x");
  const before = {
    oss: git(dir, "rev-parse", OSS),
    frozen: git(dir, "rev-parse", FROZEN),
  };
  git(dir, "checkout", "-q", "--detach", OSS);
  fs.writeFileSync(
    path.join(dir, "gradle.properties"),
    "org.gradle.jvmargs=-Xmx2g\nversion=7.0.6-SNAPSHOT\n",
  );
  bump?.(dir);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "Next Development Version (7.0.6-SNAPSHOT)");
  const bumpCommit = git(dir, "rev-parse", "HEAD");
  git(dir, "update-ref", OSS, bumpCommit);
  git(dir, "checkout", "-q", "--detach", FROZEN);
  git(
    dir,
    "merge",
    "-q",
    "--no-ff",
    "-m",
    "Merge branch '7.0.x' into 7.0.x",
    OSS,
  );
  const merge = git(dir, "rev-parse", "HEAD");
  git(dir, "update-ref", FROZEN, merge);
  const apply = {
    branches: [
      {
        repository: "oss",
        branch: "7.0.x",
        ref: OSS,
        before: before.oss,
        after: bumpCommit,
        changed: true,
      },
      {
        repository: "commercial",
        branch: "embargoed/frozen/7.0.x",
        ref: FROZEN,
        before: before.frozen,
        after: merge,
        changed: true,
      },
    ],
    created: { oss: [bumpCommit], commercial: [merge] },
  };
  const bare = (remote, branch) => git(remote, "rev-parse", branch);
  return { fixture, dir, apply, bumpCommit, merge, bare };
}

const run = (s, mode) => pushFreeze({ directory: s.dir, apply: s.apply, mode });

/** The title of the error that a function throws, which GitHub shows as the title of the error. */
const titleOf = (fn) => {
  try {
    fn();
  } catch (error) {
    return error.title;
  }
  return undefined;
};

describe("pushFreeze", () => {
  describe("the check", () => {
    it("tries both pushes and sends nothing", () => {
      const s = simulate();
      const result = run(s, "check");
      expect(result.mode).toBe("check");
      expect(result.commercial.pushed).toBe(false);
      expect(result.oss.pushed).toBe(false);
      expect(result.leakCheck).toEqual({ problems: [], commits: 1 });
      expect(s.bare(s.fixture.oss, "7.0.x")).not.toBe(s.bumpCommit);
      expect(s.bare(s.fixture.commercial, "embargoed/frozen/7.0.x")).not.toBe(
        s.merge,
      );
    });

    it("says that a push would be refused: someone pushed to OSS in the meantime", () => {
      const s = simulate();
      s.fixture.pushCommit(
        "oss",
        "7.0.x",
        "src/New.txt",
        "new\n",
        "Someone else",
      );
      expect(() => run(s, "check")).toThrow(
        /OSS branches would be refused, and nothing was pushed/,
      );
    });
  });

  describe("the push", () => {
    it("pushes the commercial branches and then the OSS ones, without force", () => {
      const s = simulate();
      const result = run(s, "push");
      expect(result.commercial.pushed).toBe(true);
      expect(result.oss.pushed).toBe(true);
      expect(s.bare(s.fixture.oss, "7.0.x")).toBe(s.bumpCommit);
      expect(s.bare(s.fixture.commercial, "embargoed/frozen/7.0.x")).toBe(
        s.merge,
      );
      // OSS has the version commit and none of the embargoed commits
      expect(git(s.fixture.oss, "log", "--format=%s", "7.0.x")).not.toMatch(
        /vulnerability/,
      );
      expect(
        git(s.fixture.oss, "branch", "--contains", s.bumpCommit).trim(),
      ).toBe("7.0.x");
    });

    it("pushes only the branches that changed, with refspecs that are never forced", () => {
      const s = simulate();
      s.apply.branches.push({
        repository: "commercial",
        branch: "embargoed/lts/6.5.x",
        ref: "refs/freeze/commercial/embargoed/lts/6.5.x",
        before: "a",
        after: "a",
        changed: false,
      });
      const specs = [
        ...refspecsOf(s.apply, "commercial"),
        ...refspecsOf(s.apply, "oss"),
      ];
      expect(specs.map((r) => r.refspec)).toEqual([
        `${FROZEN}:refs/heads/embargoed/frozen/7.0.x`,
        `${OSS}:refs/heads/7.0.x`,
      ]);
      expect(specs.some((r) => r.refspec.startsWith("+"))).toBe(false);
    });

    it("pushes nothing at all if the commercial push is refused", () => {
      const s = simulate();
      s.fixture.pushCommit(
        "commercial",
        "embargoed/frozen/7.0.x",
        "src/New.txt",
        "new\n",
        "Someone else",
      );
      let error;
      try {
        run(s, "push");
      } catch (e) {
        error = e;
      }
      expect(error.message).toMatch(
        /commercial branches was refused, and nothing was pushed/,
      );
      expect(s.bare(s.fixture.oss, "7.0.x")).not.toBe(s.bumpCommit);
      expect(error.result.oss.pushed).toBe(false);
    });

    it("says what is left to push when OSS is refused after the commercial push worked", () => {
      const s = simulate();
      s.fixture.pushCommit(
        "oss",
        "7.0.x",
        "src/New.txt",
        "new\n",
        "Someone else",
      );
      let error;
      try {
        run(s, "push");
      } catch (e) {
        error = e;
      }
      expect(error.message).toMatch(
        /The commercial branches were pushed, and the OSS branches were refused/,
      );
      expect(error.message).toContain(`${s.bumpCommit}:refs/heads/7.0.x`);
      expect(error.result.commercial.pushed).toBe(true);
      expect(s.bare(s.fixture.commercial, "embargoed/frozen/7.0.x")).toBe(
        s.merge,
      );
    });

    it("refuses a mode that is not check or push", () => {
      expect(() => run(simulate(), "both")).toThrow(/check or push/);
    });
  });

  describe("the tripwire: nothing commercial reaches OSS", () => {
    const leaks = (s) =>
      checkNothingCommercialInOss({ directory: s.dir, apply: s.apply });
    const pushedNothing = (s) => {
      expect(s.bare(s.fixture.oss, "7.0.x")).not.toBe(s.bumpCommit);
      expect(s.bare(s.fixture.commercial, "embargoed/frozen/7.0.x")).not.toBe(
        s.merge,
      );
    };

    it("passes for what the freeze made", () => {
      expect(leaks(simulate())).toEqual({ problems: [], commits: 1 });
    });

    it("fails for an OSS branch that has the commercial branch as a parent", () => {
      const s = simulate();
      const tree = git(s.dir, "rev-parse", `${s.bumpCommit}^{tree}`);
      const commercialParent = git(
        s.dir,
        "rev-parse",
        "refs/remotes/origin/embargoed/frozen/7.0.x",
      );
      const leaked = git(
        s.dir,
        "commit-tree",
        tree,
        "-p",
        commercialParent,
        "-m",
        "Next Development Version (7.0.6-SNAPSHOT)",
      );
      git(s.dir, "update-ref", OSS, leaked);
      s.apply.branches[0].after = leaked;
      s.apply.created.oss.push(leaked);
      const { problems } = leaks(s);
      expect(problems.join("\n")).toMatch(/is in the commercial repository/);
      expect(titleOf(() => run(s, "push"))).toBe(
        "Commercial code would reach OSS",
      );
      expect(s.bare(s.fixture.oss, "7.0.x")).not.toBe(leaked);
      expect(s.bare(s.fixture.commercial, "embargoed/frozen/7.0.x")).not.toBe(
        s.merge,
      );
    });

    it("fails for a merge into OSS of a commercial branch", () => {
      const s = simulate();
      git(s.dir, "checkout", "-q", "--detach", OSS);
      git(
        s.dir,
        "merge",
        "-q",
        "--no-ff",
        "-m",
        "merge(ours): 7.0.x into 7.1.x",
        "refs/remotes/origin/embargoed/active/7.0.x",
      );
      const merged = git(s.dir, "rev-parse", "HEAD");
      git(s.dir, "update-ref", OSS, merged);
      s.apply.created.oss.push(merged);
      const { problems } = leaks(s);
      expect(problems.join("\n")).toMatch(/is in the commercial repository/);
      expect(titleOf(() => run(s, "check"))).toBe(
        "Commercial code would reach OSS",
      );
    });

    it("fails for a commit that the freeze did not make", () => {
      const s = simulate();
      s.apply.created.oss = [];
      expect(leaks(s).problems.join("\n")).toMatch(
        /was not made by the freeze/,
      );
      expect(titleOf(() => run(s, "push"))).toBe(
        "Commercial code would reach OSS",
      );
      pushedNothing(s);
    });

    it("fails for a version commit that changes another file", () => {
      const s = simulate(
        {},
        {
          bump: (dir) =>
            fs.writeFileSync(path.join(dir, "README.txt"), "changed\n"),
        },
      );
      expect(leaks(s).problems.join("\n")).toMatch(
        /changes README\.txt, gradle\.properties/,
      );
      expect(titleOf(() => run(s, "push"))).toBe(
        "Commercial code would reach OSS",
      );
      pushedNothing(s);
    });

    it("fails for a message that names an embargoed branch", () => {
      const s = simulate();
      git(s.dir, "checkout", "-q", "--detach", OSS);
      git(
        s.dir,
        "commit",
        "-q",
        "--amend",
        "-m",
        "Merge branch 'embargoed/frozen/7.0.x' into 7.0.x",
      );
      const amended = git(s.dir, "rev-parse", "HEAD");
      git(s.dir, "update-ref", OSS, amended);
      s.apply.created.oss = [amended];
      expect(leaks(s).problems.join("\n")).toMatch(
        /has embargoed in its message/,
      );
    });

    it("fails for a merge whose parent is neither in OSS nor made by the freeze", () => {
      const s = simulate();
      const tree = git(s.dir, "rev-parse", `${s.bumpCommit}^{tree}`);
      const stray = git(s.dir, "commit-tree", tree, "-m", "A stray commit");
      const merge = git(
        s.dir,
        "commit-tree",
        tree,
        "-p",
        s.bumpCommit,
        "-p",
        stray,
        "-m",
        "merge(ours): 7.0.x into 7.1.x",
      );
      git(s.dir, "update-ref", OSS, merge);
      s.apply.created.oss.push(merge);
      const { problems } = leaks(s);
      expect(problems.join("\n")).toMatch(
        /has the parent .*, which is not in OSS and was not made by the freeze/,
      );
    });

    it("is not fooled by a commercial main and a 7.0.x of the same names as the OSS ones", () => {
      const s = simulate({ collide: true });
      expect(leaks(s)).toEqual({ problems: [], commits: 1 });
      expect(run(s, "push").oss.pushed).toBe(true);
      expect(git(s.fixture.oss, "log", "--format=%s", "7.0.x")).not.toMatch(
        /Commercial only/,
      );
    });
  });
});
