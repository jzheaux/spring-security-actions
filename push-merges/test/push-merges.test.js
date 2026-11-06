import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pushMerges, refspecsOf, summaryOf } from "../src/index.js";
import {
  commitFiles,
  createFixture,
  git,
  head,
  refusePushes,
  simulateMerges,
} from "./support/fixture.js";
import { runAction } from "./support/run-action.js";

const push = (f, merge, mode) => pushMerges({ directory: f.work, merge, mode });
const OSS = "7.0.x";
const FROZEN = "embargoed/frozen/7.0.x";
const where = (f) => ({
  oss: head(f.oss, OSS),
  frozen: head(f.commercial, FROZEN),
});

describe("check", () => {
  it("looks at the commits that go to OSS, tries both pushes, and pushes nothing", () => {
    const f = createFixture();
    const merge = simulateMerges(f);
    const before = where(f);
    const result = push(f, merge, "check");
    expect(result.mode).toBe("check");
    expect(result.leakCheck).toEqual({ problems: [], commits: 1 });
    expect(result.oss).toMatchObject({
      pushed: false,
      branches: [{ branch: OSS }],
    });
    expect(result.commercial).toMatchObject({
      pushed: false,
      branches: [{ branch: FROZEN }],
    });
    expect(where(f)).toEqual(before);
  });

  it("says that a push would be refused when someone pushed to the branch since", () => {
    const f = createFixture({ fresh: true });
    const merge = simulateMerges(f);
    git(f.seed, "fetch", "-q", "oss", OSS);
    git(f.seed, "switch", "-q", "--detach", "FETCH_HEAD");
    commitFiles(f.seed, { "src/Other.txt": "x\n" }, "Someone else");
    git(f.seed, "push", "-q", "oss", `HEAD:refs/heads/${OSS}`);
    const before = where(f);
    expect(() => push(f, merge, "check")).toThrow(
      "Pushing the OSS branches would be refused, and nothing was pushed",
    );
    expect(where(f)).toEqual(before);
  });
});

describe("push", () => {
  it("pushes OSS and then the commercial repository, with the merges", () => {
    const f = createFixture({ fresh: true });
    const merge = simulateMerges(f);
    const result = push(f, merge, "push");
    expect(result.oss.pushed).toBe(true);
    expect(result.commercial.pushed).toBe(true);
    expect(head(f.oss, OSS)).toBe(merge.branches[0].after);
    expect(head(f.commercial, FROZEN)).toBe(merge.branches[1].after);
    // OSS has what the tag has (the fix, which was embargoed until the release), and nothing
    // that is only commercial, such as the commit of the active branch
    const inOss = (file) => f.show(f.oss, `refs/heads/${OSS}`, file);
    expect(inOss("src/Fixed.txt")).toContain("the fix");
    expect(inOss(`src/Secret-${OSS}.txt`)).toBe("embargoed");
    expect(inOss(`src/Next-${OSS}.txt`)).toBeUndefined();
  });

  it("is OSS first: if OSS refuses, nothing is pushed anywhere", () => {
    const f = createFixture({ fresh: true });
    const merge = simulateMerges(f);
    refusePushes(f.oss);
    const before = where(f);
    let error;
    try {
      push(f, merge, "push");
    } catch (e) {
      error = e;
    }
    expect(error.message).toContain(
      "Pushing the OSS branches was refused, and nothing was pushed",
    );
    expect(error.result.oss.pushed).toBe(false);
    expect(where(f)).toEqual(before);
  });

  it("says what is left, and how, if the commercial repository refuses after OSS was pushed", () => {
    const f = createFixture({ fresh: true });
    const merge = simulateMerges(f);
    refusePushes(f.commercial);
    const before = where(f);
    let error;
    try {
      push(f, merge, "push");
    } catch (e) {
      error = e;
    }
    expect(error.message).toContain(
      "The OSS branches were pushed, and the commercial branches were refused",
    );
    expect(error.message).toContain(
      `git push --atomic <the commercial repository> ${merge.branches[1].after}:refs/heads/${FROZEN}`,
    );
    expect(error.message).toContain("is not merged again");
    expect(head(f.oss, OSS)).toBe(merge.branches[0].after);
    expect(head(f.commercial, FROZEN)).toBe(before.frozen);
    expect(error.result.oss.pushed).toBe(true);
    expect(error.result.commercial.pushed).toBe(false);
  });

  it("pushes nothing for a branch that did not change, so a run can be repeated", () => {
    const f = createFixture({ fresh: true });
    const merge = simulateMerges(f);
    for (const b of merge.branches) {
      b.changed = false;
    }
    const before = where(f);
    const result = push(f, merge, "push");
    expect(result.oss.branches).toEqual([]);
    expect(result.commercial.branches).toEqual([]);
    expect(where(f)).toEqual(before);
  });

  it("never forces: a refspec has no +, and names a branch of its own", () => {
    const f = createFixture();
    const merge = simulateMerges(f);
    const refspecs = [
      ...refspecsOf(merge, "oss"),
      ...refspecsOf(merge, "commercial"),
    ];
    expect(refspecs.map((r) => r.refspec)).toEqual([
      "refs/post-publish/oss/7.0.x:refs/heads/7.0.x",
      "refs/post-publish/commercial/embargoed/frozen/7.0.x:refs/heads/embargoed/frozen/7.0.x",
    ]);
    expect(refspecs.every((r) => !r.refspec.startsWith("+"))).toBe(true);
  });
});

describe("nothing commercial reaches OSS", () => {
  const leaks = {
    commit: [
      "A commit that no merge made",
      "was not made by the merges of the tag",
    ],
    message: [
      "Merge embargoed/frozen/7.0.x into 7.0.x",
      "has embargoed in its message",
    ],
    commercial: [
      "Merge branch '7.0.x' into 7.0.x",
      "is in the commercial repository",
    ],
  };
  it.each(Object.entries(leaks))(
    "stops a %s, before anything is pushed",
    (leak, [commit, problem]) => {
      const f = createFixture({ fresh: true });
      const merge = simulateMerges(f, { leak });
      const before = where(f);
      for (const mode of ["check", "push"]) {
        let error;
        try {
          push(f, merge, mode);
        } catch (e) {
          error = e;
        }
        expect(error.title).toBe("Commercial code would reach OSS");
        expect(error.message).toContain("Nothing was pushed");
        expect(error.message).toContain(problem);
        expect(error.message).toContain(commit);
      }
      expect(where(f)).toEqual(before);
    },
  );

  it("says that the parent of a merge is not in OSS", () => {
    const f = createFixture({ fresh: true });
    const merge = simulateMerges(f, { leak: "commercial" });
    expect(() => push(f, merge, "check")).toThrow(
      "which is not in OSS and was not made by the merges of the tag",
    );
  });

  it("does not count the commits of the tag, which OSS has", () => {
    const f = createFixture();
    const merge = simulateMerges(f);
    const tagOnly = git(
      f.work,
      "rev-list",
      "--count",
      "refs/post-publish/tag",
      "--not",
      "--remotes=oss",
    );
    expect(Number(tagOnly)).toBeGreaterThan(0);
    expect(push(f, merge, "check").leakCheck.commits).toBe(1);
  });

  it("is a hard error for anything that is not an OSS release to have an OSS branch", () => {
    const f = createFixture();
    const merge = simulateMerges(f, { kind: "lts" });
    const before = where(f);
    let error;
    try {
      push(f, merge, "push");
    } catch (e) {
      error = e;
    }
    expect(error.title).toBe("Commercial code would reach OSS");
    expect(error.message).toContain("not an OSS release");
    expect(where(f)).toEqual(before);
  });

  it("pushes a long-term support release to the commercial repository only, with no OSS remote", () => {
    const f = createFixture({ fresh: true });
    git(
      f.work,
      "update-ref",
      "refs/post-publish/commercial/embargoed/lts/5.8.x",
      "refs/remotes/origin/embargoed/lts/5.8.x",
    );
    git(
      f.work,
      "checkout",
      "-q",
      "--detach",
      "refs/post-publish/commercial/embargoed/lts/5.8.x",
    );
    commitFiles(
      f.work,
      { "src/Fixed.txt": "the fix\n" },
      "Merge tag '5.8.30' into 5.8.x",
    );
    git(
      f.work,
      "update-ref",
      "refs/post-publish/commercial/embargoed/lts/5.8.x",
      "HEAD",
    );
    const after = git(f.work, "rev-parse", "HEAD");
    const merge = {
      kind: "lts",
      tag: "5.8.30",
      branches: [
        {
          repository: "commercial",
          branch: "embargoed/lts/5.8.x",
          ref: "refs/post-publish/commercial/embargoed/lts/5.8.x",
          before: "x",
          after,
          changed: true,
        },
      ],
      created: { oss: [], commercial: [after] },
    };
    expect(git(f.work, "remote")).toBe("origin");
    const result = push(f, merge, "push");
    expect(result.commercial.pushed).toBe(true);
    expect(result.oss.branches).toEqual([]);
    expect(head(f.commercial, "embargoed/lts/5.8.x")).toBe(after);
  });
});

describe("the summary", () => {
  it("says what would be pushed, OSS first, and what the tripwire looked at", () => {
    const f = createFixture();
    const text = summaryOf(push(f, simulateMerges(f), "check"));
    expect(text).toContain("### Pushes of the merges of 7.0.9 (dry run)");
    expect(text.indexOf("| OSS |")).toBeLessThan(
      text.indexOf("| commercial |"),
    );
    expect(text).toContain("would be pushed");
    expect(text).toContain(
      "The OSS check: 1 commits would be sent to OSS, all merges whose parents are in OSS.",
    );
    expect(text).toContain("`--atomic --dry-run` was accepted");
  });

  it("says that nothing is left to push", () => {
    const f = createFixture();
    const merge = simulateMerges(f);
    merge.branches.forEach((b) => (b.changed = false));
    expect(summaryOf(push(f, merge, "push"))).toContain(
      "Nothing to push: every branch has the tag already.",
    );
  });
});

describe("the action", () => {
  const inputs = (f, merge, extra = {}) => {
    const dir = fs.mkdtempSync(path.join(f.root, "files-"));
    const mergeFile = path.join(dir, "merge.json");
    fs.writeFileSync(mergeFile, JSON.stringify(merge));
    return {
      inputs: {
        mode: "check",
        "merge-file": mergeFile,
        "push-file": path.join(dir, "push.json"),
        path: f.work,
        ...extra,
      },
      dir,
    };
  };

  it("checks, writes the file of what it did, and has a summary", async () => {
    const f = createFixture();
    const merge = simulateMerges(f);
    const { inputs: input, dir } = inputs(f, merge);
    const summary = path.join(dir, "summary.md");
    const result = await runAction("src/index.js", input, {
      HOME: f.root,
      GITHUB_STEP_SUMMARY: summary,
    });
    expect(result.code).toBe(0);
    expect(result.outputs["push-file"]).toBe(input["push-file"]);
    expect(JSON.parse(fs.readFileSync(input["push-file"], "utf8")).mode).toBe(
      "check",
    );
    expect(fs.readFileSync(summary, "utf8")).toContain(
      "Pushes of the merges of 7.0.9",
    );
  });

  it("has no summary when it is asked for none", async () => {
    const f = createFixture();
    const { inputs: input, dir } = inputs(f, simulateMerges(f), {
      summary: "false",
    });
    const summary = path.join(dir, "summary.md");
    const result = await runAction("src/index.js", input, {
      HOME: f.root,
      GITHUB_STEP_SUMMARY: summary,
    });
    expect(result.code).toBe(0);
    expect(fs.existsSync(summary)).toBe(false);
  });

  it("fails with an error that GitHub shows when commercial code would reach OSS, and writes what it found", async () => {
    const f = createFixture();
    const { inputs: input } = inputs(f, simulateMerges(f, { leak: "commit" }));
    const result = await runAction("src/index.js", input, { HOME: f.root });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain(
      "::error title=Commercial code would reach OSS::",
    );
    expect(fs.existsSync(input["push-file"])).toBe(true);
  });
});
