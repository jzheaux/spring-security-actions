import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyFreeze } from "../src/index.js";
import { createFixture, git } from "./support/freeze-fixture.js";

const oss = (branch, current, next) => ({
  generation: branch,
  branch,
  frozen: `embargoed/frozen/${branch}`,
  active: `embargoed/active/${branch}`,
  current,
  next,
  bump: next !== current,
});
const lts = (generation, current, next) => ({
  generation,
  branch: `embargoed/lts/${generation}`,
  current,
  next,
  bump: next !== current,
});

const plan = () => ({
  oss: [
    oss("7.0.x", "7.0.5-SNAPSHOT", "7.0.6-SNAPSHOT"),
    oss("7.1.x", "7.1.1-SNAPSHOT", "7.1.2-SNAPSHOT"),
    oss("main", "7.2.0-SNAPSHOT", "7.2.0-SNAPSHOT"),
  ],
  lts: [
    lts("6.4.x", "6.4.13-SNAPSHOT", "6.4.14-SNAPSHOT"),
    lts("6.5.x", "6.5.11-SNAPSHOT", "6.5.12-SNAPSHOT"),
  ],
});

function setup(options) {
  const fixture = createFixture(options);
  git(fixture.work, "remote", "add", "oss", fixture.oss);
  git(
    fixture.work,
    "fetch",
    "-q",
    "--no-tags",
    "oss",
    "+refs/heads/*:refs/remotes/oss/*",
  );
  const apply = (p = plan()) =>
    applyFreeze({ directory: fixture.work, plan: p });
  const show = (ref, file = "gradle.properties") =>
    git(fixture.work, "show", `${ref}:${file}`);
  const version = (ref) => /^version=(.*)$/m.exec(show(ref))[1];
  const subjects = (ref, count) =>
    git(fixture.work, "log", `-${count}`, "--format=%s", ref).split("\n");
  const ossRef = (b) => `refs/freeze/oss/${b}`;
  const com = (b) => `refs/freeze/commercial/${b}`;
  return { fixture, apply, show, version, subjects, ossRef, com };
}

describe("applyFreeze", () => {
  it("commits the next version on every OSS branch, after the merge across", () => {
    const { apply, version, subjects, ossRef } = setup();
    apply();
    expect(version(ossRef("7.0.x"))).toBe("7.0.6-SNAPSHOT");
    expect(version(ossRef("7.1.x"))).toBe("7.1.2-SNAPSHOT");
    expect(version(ossRef("main"))).toBe("7.2.0-SNAPSHOT");
    expect(subjects(ossRef("7.0.x"), 1)).toEqual([
      "Next Development Version (7.0.6-SNAPSHOT)",
    ]);
    // the merge, and then the version: the version of the merge is the one of its own branch
    expect(subjects(ossRef("7.1.x"), 2)).toEqual([
      "Next Development Version (7.1.2-SNAPSHOT)",
      "merge(ours): 7.0.x into 7.1.x",
    ]);
    // a branch whose version stays has no version commit, and is merged all the same
    expect(subjects(ossRef("main"), 1)).toEqual([
      "merge(ours): 7.1.x into main",
    ]);
  });

  it("never lets a merge change the version of the target", () => {
    const { apply, version, ossRef, fixture } = setup();
    apply();
    const merge = git(fixture.work, "rev-parse", `${ossRef("7.1.x")}~1`);
    expect(version(merge)).toBe("7.1.1-SNAPSHOT");
    expect(version(`${ossRef("main")}`)).toBe("7.2.0-SNAPSHOT");
    expect(version(`${ossRef("7.1.x")}~1`)).toBe("7.1.1-SNAPSHOT");
  });

  it("carries the other changes across with the merge", () => {
    const { apply, show, ossRef, fixture } = setup();
    fixture.pushCommit(
      "oss",
      "7.0.x",
      "src/Fix.txt",
      "a fix\n",
      "A fix on 7.0.x",
    );
    git(
      fixture.work,
      "fetch",
      "-q",
      "--no-tags",
      "oss",
      "+refs/heads/*:refs/remotes/oss/*",
    );
    apply();
    expect(show(ossRef("7.1.x"), "src/Fix.txt")).toBe("a fix");
    expect(show(ossRef("main"), "src/Fix.txt")).toBe("a fix");
  });

  it("changes only the line of the version, and signs the commits off without a key", () => {
    const { apply, ossRef, fixture } = setup();
    apply();
    expect(
      git(fixture.work, "show", "--format=", "--name-only", ossRef("7.0.x")),
    ).toBe("gradle.properties");
    expect(git(fixture.work, "show", "--format=", ossRef("7.0.x"))).toMatch(
      /-version=7\.0\.5-SNAPSHOT\n\+version=7\.0\.6-SNAPSHOT/,
    );
    expect(
      git(fixture.work, "log", "-1", "--format=%B", ossRef("7.0.x")),
    ).toMatch(/Signed-off-by: Alice/);
    expect(
      git(fixture.work, "log", "-1", "--format=%G?", ossRef("7.0.x")),
    ).toBe("N");
  });

  it("merges the OSS branch down into the frozen and then the active branch, with its version", () => {
    const { apply, version, show, subjects, com, fixture } = setup();
    const result = apply();
    for (const [b, v] of [
      ["7.0.x", "7.0.6-SNAPSHOT"],
      ["7.1.x", "7.1.2-SNAPSHOT"],
      ["main", "7.2.0-SNAPSHOT"],
    ]) {
      expect(version(com(`embargoed/frozen/${b}`))).toBe(v);
      expect(version(com(`embargoed/active/${b}`))).toBe(v);
    }
    // the embargoed fixes are still there, and so is the bump of OSS, by the merge
    expect(show(com("embargoed/frozen/7.0.x"), "src/Secret-7.0.x.txt")).toBe(
      "embargoed",
    );
    expect(show(com("embargoed/active/7.0.x"), "src/Next-7.0.x.txt")).toBe(
      "embargoed",
    );
    expect(subjects(com("embargoed/active/7.0.x"), 1)).toEqual([
      "Merge branch '7.0.x' into 7.0.x",
    ]);
    const downs = result.merges.filter((m) => m.kind === "down");
    expect(downs).toHaveLength(6);
    expect(
      git(
        fixture.work,
        "merge-base",
        "--is-ancestor",
        "refs/freeze/oss/7.0.x",
        com("embargoed/frozen/7.0.x"),
      ),
    ).toBe("");
  });

  it("merges across in the embargoed branches too, with the generation names, and keeps their own version", () => {
    const { apply, version, subjects, com } = setup();
    apply();
    // main of frozen: across from 7.1.x, then down from OSS main
    const log = subjects(com("embargoed/frozen/7.1.x"), 3);
    expect(log).toContain("merge(ours): 7.0.x into 7.1.x");
    expect(log).toContain("Merge branch '7.1.x' into 7.1.x");
    expect(version(com("embargoed/frozen/7.1.x"))).toBe("7.1.2-SNAPSHOT");
  });

  it("fast forwards each frozen branch to its active branch, and makes no commit for it", () => {
    const { apply } = setup();
    const result = apply();
    expect(result.rotation).toHaveLength(3);
    for (const r of result.rotation) {
      expect(r.to).not.toBe(r.from);
    }
    // the commit of a rotation is the one of the active branch: it created none of its own
    const total =
      result.merges.filter((m) => m.repository === "commercial").length +
      result.bumps.filter((b) => b.branch.startsWith("embargoed/lts")).length;
    expect(result.created.commercial).toHaveLength(total);
  });

  it("leaves the frozen and the active branch at one commit", () => {
    const { apply, fixture } = setup();
    apply();
    for (const b of ["7.0.x", "7.1.x", "main"]) {
      expect(
        git(
          fixture.work,
          "rev-parse",
          `refs/freeze/commercial/embargoed/frozen/${b}`,
        ),
      ).toBe(
        git(
          fixture.work,
          "rev-parse",
          `refs/freeze/commercial/embargoed/active/${b}`,
        ),
      );
    }
  });

  it("bumps and merges the long-term support branches among themselves only", () => {
    const { apply, version, subjects, com, fixture } = setup();
    apply();
    expect(version(com("embargoed/lts/6.4.x"))).toBe("6.4.14-SNAPSHOT");
    expect(version(com("embargoed/lts/6.5.x"))).toBe("6.5.12-SNAPSHOT");
    expect(subjects(com("embargoed/lts/6.5.x"), 2)).toEqual([
      "Next Development Version (6.5.12-SNAPSHOT)",
      "merge(ours): 6.4.x into 6.5.x",
    ]);
    // no long-term support commit is in a branch that is not one
    expect(
      git(
        fixture.work,
        "rev-list",
        "--count",
        "refs/freeze/oss/main",
        `--grep=6.5.12`,
      ),
    ).toBe("0");
  });

  it("does not touch any branch of the clone or of the remotes: the work is in refs/freeze", () => {
    const { apply, fixture } = setup();
    const refs = () =>
      git(
        fixture.work,
        "for-each-ref",
        "--format=%(refname) %(objectname)",
        "refs/heads",
        "refs/remotes",
      );
    const before = refs();
    apply();
    expect(refs()).toBe(before);
  });

  it("does not put a commit that is only commercial in an OSS branch", () => {
    const { apply, fixture } = setup({ collide: true });
    const result = apply();
    const created = new Set(result.created.oss);
    for (const b of ["7.0.x", "7.1.x", "main"]) {
      const pushed = git(
        fixture.work,
        "rev-list",
        `refs/freeze/oss/${b}`,
        "--not",
        "--remotes=oss",
      )
        .split("\n")
        .filter(Boolean);
      expect(pushed.length).toBeGreaterThan(0);
      for (const commit of pushed) {
        expect(created.has(commit)).toBe(true);
      }
      expect(
        git(fixture.work, "log", "--format=%s", `refs/freeze/oss/${b}`),
      ).not.toMatch(/Commercial only|vulnerability/);
    }
  });

  it("says which branch each merge is into", () => {
    const { apply } = setup();
    const result = apply();
    const into = result.merges.map(
      (m) => `${m.kind} ${m.message} -> ${m.into}`,
    );
    expect(into).toContain("across merge(ours): 7.0.x into 7.1.x -> 7.1.x");
    expect(into).toContain(
      "across merge(ours): 7.0.x into 7.1.x -> embargoed/frozen/7.1.x",
    );
    expect(into).toContain(
      "across merge(ours): 7.0.x into 7.1.x -> embargoed/active/7.1.x",
    );
    expect(into).toContain(
      "down Merge branch '7.0.x' into 7.0.x -> embargoed/frozen/7.0.x",
    );
    expect(into).toContain(
      "down Merge branch '7.0.x' into 7.0.x -> embargoed/active/7.0.x",
    );
    expect(into).toContain(
      "across merge(ours): 6.4.x into 6.5.x -> embargoed/lts/6.5.x",
    );
  });

  it("records the commits that it created, and the refs before and after", () => {
    const { apply } = setup();
    const result = apply();
    // OSS: 2 bumps and 2 merges. Commercial: 3 bumps... the long-term support bumps and merge, and the downs
    expect(result.created.oss).toHaveLength(4);
    expect(result.bumps.map((b) => `${b.branch} ${b.to}`)).toEqual([
      "7.0.x 7.0.6-SNAPSHOT",
      "7.1.x 7.1.2-SNAPSHOT",
      "embargoed/lts/6.4.x 6.4.14-SNAPSHOT",
      "embargoed/lts/6.5.x 6.5.12-SNAPSHOT",
    ]);
    const main = result.branches.find((b) => b.ref === "refs/freeze/oss/main");
    expect(main.changed).toBe(true);
    expect(main.before).not.toBe(main.after);
    expect(result.branches.filter((b) => b.repository === "oss")).toHaveLength(
      3,
    );
  });

  it("fails, and says the file, for a conflict that is not the version", () => {
    const { apply, fixture } = setup();
    fixture.pushCommit(
      "oss",
      "7.0.x",
      "README.txt",
      "seven zero\n",
      "Change on 7.0.x",
    );
    fixture.pushCommit(
      "oss",
      "7.1.x",
      "README.txt",
      "seven one\n",
      "Change on 7.1.x",
    );
    git(
      fixture.work,
      "fetch",
      "-q",
      "--no-tags",
      "oss",
      "+refs/heads/*:refs/remotes/oss/*",
    );
    expect(() => apply()).toThrow(/conflicts in README\.txt/);
    // the merge is undone
    expect(git(fixture.work, "status", "--porcelain")).toBe("");
  });

  it("fails for a dirty working tree", () => {
    const { apply, fixture } = setup();
    fs.writeFileSync(path.join(fixture.work, "untracked.txt"), "changed\n");
    expect(() => apply()).toThrow(/not clean/);
  });

  it("fails if git does not know who commits", () => {
    const { apply, fixture } = setup();
    git(fixture.work, "config", "--unset", "user.name");
    git(fixture.work, "config", "--unset", "user.email");
    const keep = { ...process.env };
    process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    process.env.GIT_CONFIG_SYSTEM = "/dev/null";
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
      expect(() => apply()).toThrow("git does not know who commits");
    } finally {
      process.env = keep;
    }
  });

  it("merges nothing that is in the branch already", () => {
    const { apply } = setup();
    const p = plan();
    p.oss = [p.oss[0]];
    p.lts = [];
    const result = apply(p);
    expect(result.merges.filter((m) => m.kind === "across")).toEqual([]);
    expect(result.bumps).toHaveLength(1);
  });

  it("can not fast forward a frozen branch that is not in the active one", () => {
    const { fixture } = setup();
    const p = plan();
    p.oss = [p.oss[0]];
    p.lts = [];
    // an active branch that does not have the frozen one: the down merge of frozen would make
    // it so, so the rotation is only possible; check the failure of the fast forward directly
    git(
      fixture.work,
      "checkout",
      "-q",
      "--detach",
      "refs/remotes/origin/embargoed/frozen/7.0.x",
    );
    git(fixture.work, "commit", "-q", "--allow-empty", "-m", "A frozen commit");
    const frozen = git(fixture.work, "rev-parse", "HEAD");
    git(fixture.work, "update-ref", "refs/freeze/test/frozen", frozen);
    git(
      fixture.work,
      "checkout",
      "-q",
      "--detach",
      "refs/remotes/origin/embargoed/active/7.0.x",
    );
    git(
      fixture.work,
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "An active commit",
    );
    git(fixture.work, "checkout", "-q", "--detach", "refs/freeze/test/frozen");
    expect(() =>
      git(
        fixture.work,
        "merge",
        "--ff-only",
        "-q",
        "refs/remotes/origin/embargoed/active/7.0.x",
      ),
    ).toThrow();
  });
});
