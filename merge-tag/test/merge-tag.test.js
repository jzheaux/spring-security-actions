import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { catalogVersions, mergeTag, summaryOf } from "../src/index.js";
import { createFixture, git, ltsPlan, ossPlan } from "./support/fixture.js";
import { runAction } from "./support/run-action.js";

const ossUrl = (f) => f.oss;
const run = (f, plan) =>
  mergeTag({ directory: f.work, plan, ossUrl: ossUrl(f) });
const branch = (result, name) => result.branches.find((b) => b.branch === name);
/** What a work ref of the clone has in a file. */
const at = (f, result, name, file) =>
  f.show(f.work, branch(result, name).after, file);
const catalogAt = (f, result, name) =>
  Object.fromEntries(
    Object.entries(
      catalogVersions(at(f, result, name, "gradle/libs.versions.toml")),
    ).filter(([key]) =>
      ["spring-framework", "reactor", "micrometer"].includes(key),
    ),
  );
const versionAt = (f, result, name) =>
  /^version=(.*)$/m.exec(at(f, result, name, "gradle.properties"))[1];

const OSS_CHAIN = ["7.0.x", "7.1.x", "main"];

// One merge of the OSS release 7.0.9 through the whole chain, which the tests that only read
// what it did share: a merge makes many git commands, and these tests do not change it.
let f;
let result;
beforeAll(() => {
  f = createFixture();
  result = run(f, ossPlan("7.0.9", OSS_CHAIN));
});

describe("an OSS release", () => {
  it("merges the tag into its branch, and forward, in the order of the freeze, with these messages", () => {
    expect(result.kind).toBe("oss");
    expect(result.merges.map((m) => [m.repository, m.into, m.message])).toEqual(
      [
        ["oss", "7.0.x", "Merge tag '7.0.9' into 7.0.x"],
        ["oss", "7.1.x", "Merge branch '7.0.x' into 7.1.x"],
        ["oss", "main", "Merge branch '7.1.x' into main"],
        [
          "commercial",
          "embargoed/frozen/7.0.x",
          "Merge branch '7.0.x' into 7.0.x",
        ],
        [
          "commercial",
          "embargoed/active/7.0.x",
          "Merge branch '7.0.x' into 7.0.x",
        ],
        [
          "commercial",
          "embargoed/frozen/7.1.x",
          "Merge branch '7.0.x' into 7.1.x",
        ],
        [
          "commercial",
          "embargoed/frozen/7.1.x",
          "Merge branch '7.1.x' into 7.1.x",
        ],
        [
          "commercial",
          "embargoed/active/7.1.x",
          "Merge branch '7.0.x' into 7.1.x",
        ],
        [
          "commercial",
          "embargoed/active/7.1.x",
          "Merge branch '7.1.x' into 7.1.x",
        ],
        [
          "commercial",
          "embargoed/frozen/main",
          "Merge branch '7.1.x' into main",
        ],
        [
          "commercial",
          "embargoed/frozen/main",
          "Merge branch 'main' into main",
        ],
        [
          "commercial",
          "embargoed/active/main",
          "Merge branch '7.1.x' into main",
        ],
        [
          "commercial",
          "embargoed/active/main",
          "Merge branch 'main' into main",
        ],
      ],
    );
    expect(result.merges.every((m) => m.outcome === "merged")).toBe(true);
    expect(result.created.oss).toHaveLength(3);
    expect(result.created.commercial).toHaveLength(10);
    expect(JSON.stringify(result.merges.map((m) => m.message))).not.toMatch(
      /embargoed/,
    );
  });

  it("brings the fix of the tag into every branch, the OSS, frozen and active ones", () => {
    for (const name of [
      "7.0.x",
      "7.1.x",
      "main",
      ...OSS_CHAIN.flatMap((b) => [
        `embargoed/frozen/${b}`,
        `embargoed/active/${b}`,
      ]),
    ]) {
      expect(at(f, result, name, "src/Fixed.txt"), name).toContain("the fix");
    }
  });

  it("keeps the version of gradle.properties of every branch", () => {
    expect(versionAt(f, result, "7.0.x")).toBe("7.0.9-SNAPSHOT");
    expect(versionAt(f, result, "7.1.x")).toBe("7.1.3-SNAPSHOT");
    expect(versionAt(f, result, "main")).toBe("7.2.0-SNAPSHOT");
    for (const [b, v] of [
      ["7.0.x", "7.0.9"],
      ["7.1.x", "7.1.3"],
      ["main", "7.2.0"],
    ]) {
      expect(versionAt(f, result, `embargoed/frozen/${b}`)).toBe(
        `${v}-SNAPSHOT`,
      );
      expect(versionAt(f, result, `embargoed/active/${b}`)).toBe(
        `${v}-SNAPSHOT`,
      );
    }
  });

  it("takes the catalog of the tag into its branch, keeps the one of each generation across, and takes the one of the source down", () => {
    const tag = {
      "spring-framework": "7.0.11",
      reactor: "2025.0.9",
      micrometer: "1.16.9",
    };
    // the tag into the branch: the catalog of the tag
    expect(catalogAt(f, result, "7.0.x")).toEqual(tag);
    // across: where both changed it, the target's; a line that only the tag changed comes
    expect(catalogAt(f, result, "7.1.x")).toEqual({
      "spring-framework": "7.0.11",
      reactor: "2025.0.7",
      micrometer: "1.17.1",
    });
    expect(catalogAt(f, result, "main")).toEqual({
      "spring-framework": "7.1.0-M2",
      reactor: "2026.0.0-M1",
      micrometer: "1.18.0-M1",
    });
    // down: the frozen and active branches get what their OSS branch has
    expect(catalogAt(f, result, "embargoed/frozen/7.0.x")).toEqual(tag);
    expect(catalogAt(f, result, "embargoed/active/7.0.x")).toEqual(tag);
    expect(catalogAt(f, result, "embargoed/frozen/7.1.x")).toEqual(
      catalogAt(f, result, "7.1.x"),
    );
    expect(catalogAt(f, result, "embargoed/active/main")).toEqual(
      catalogAt(f, result, "main"),
    );
  });

  it("says in the merges what each changed in the versions of the catalog", () => {
    const changes = (into, source) =>
      result.merges.find((m) => m.into === into && m.source === source).catalog;
    expect(
      changes("7.0.x", "7.0.9")
        .map((c) => c.key)
        .sort(),
    ).toEqual(["micrometer", "reactor", "spring-framework"]);
    expect(changes("7.1.x", "7.0.x")).toEqual([
      { key: "spring-framework", from: "7.0.8", to: "7.0.11" },
    ]);
    expect(changes("main", "7.1.x")).toEqual([]);
  });

  it("works on refs of its own, and changes no branch of the clone", () => {
    const f = createFixture();
    const before = git(f.work, "for-each-ref", "refs/heads", "refs/remotes");
    const head = git(f.work, "rev-parse", "HEAD");
    run(f, ossPlan("7.0.9", OSS_CHAIN));
    expect(
      git(f.work, "for-each-ref", "refs/heads", "refs/remotes/origin"),
    ).toBe(
      before
        .split("\n")
        .filter((l) => !l.includes("refs/remotes/oss"))
        .join("\n"),
    );
    expect(git(f.work, "rev-parse", "HEAD")).not.toBe(head);
    expect(git(f.work, "status", "--porcelain")).toBe("");
  });

  it("merges only from the tag of the first branch for the newest generation", () => {
    const f = createFixture();
    const result = run(f, ossPlan("7.0.9", ["main"]));
    expect(result.merges.map((m) => m.message)).toEqual([
      "Merge tag '7.0.9' into main",
      "Merge branch 'main' into main",
      "Merge branch 'main' into main",
    ]);
  });

  it("does nothing a second time, after the branches were pushed", () => {
    const f = createFixture({ fresh: true });
    const first = run(f, ossPlan("7.0.9", OSS_CHAIN));
    for (const b of first.branches) {
      const remote = b.repository === "oss" ? f.oss : f.commercial;
      git(f.work, "push", "-q", remote, `${b.ref}:refs/heads/${b.branch}`);
    }
    git(f.work, "fetch", "-q", "origin");
    const second = run(f, ossPlan("7.0.9", OSS_CHAIN));
    expect(second.merges.every((m) => m.outcome === "up-to-date")).toBe(true);
    expect(second.created).toEqual({ oss: [], commercial: [] });
    expect(second.branches.every((b) => !b.changed)).toBe(true);
  });

  it("fails when another file conflicts, says which, and merges by hand is the way", () => {
    const f = createFixture({ conflict: true });
    let error;
    try {
      run(f, ossPlan("7.0.9", OSS_CHAIN));
    } catch (e) {
      error = e;
    }
    expect(error.title).toBe("Merge conflict");
    expect(error.message).toContain("src/Core.txt");
    expect(error.message).toContain("Nothing was pushed");
    expect(git(f.work, "status", "--porcelain")).toBe("");
  });

  it("fails if the working tree is not clean", () => {
    const f = createFixture();
    fs.writeFileSync(path.join(f.work, "README.txt"), "changed\n");
    expect(() => run(f, ossPlan("7.0.9", OSS_CHAIN))).toThrow("is not clean");
  });

  it("fails if a branch of the chain does not exist in the clone", () => {
    const f = createFixture();
    const plan = ossPlan("7.0.9", OSS_CHAIN);
    plan.merge.branches[1].frozen = "embargoed/frozen/nope";
    expect(() => run(f, plan)).toThrow("embargoed/frozen/nope");
  });
});

describe("a long-term support release", () => {
  const chain = ["5.8.x", "6.4.x", "6.5.x"];

  it("is merged through the long-term support branches, and never touches OSS", () => {
    const f = createFixture();
    const result = run(f, ltsPlan("5.8.30", chain));
    expect(result.kind).toBe("lts");
    expect(result.merges.map((m) => [m.into, m.message])).toEqual([
      ["embargoed/lts/5.8.x", "Merge tag '5.8.30' into 5.8.x"],
      ["embargoed/lts/6.4.x", "Merge branch '5.8.x' into 6.4.x"],
      ["embargoed/lts/6.5.x", "Merge branch '6.4.x' into 6.5.x"],
    ]);
    expect(result.created.oss).toEqual([]);
    expect(git(f.work, "remote")).toBe("origin");
    expect(result.branches.every((b) => b.repository === "commercial")).toBe(
      true,
    );
  });

  it("brings the fix into every branch, and keeps their versions and their catalogs", () => {
    const f = createFixture();
    const result = run(f, ltsPlan("5.8.30", chain));
    for (const name of [
      "embargoed/lts/5.8.x",
      "embargoed/lts/6.4.x",
      "embargoed/lts/6.5.x",
    ]) {
      expect(at(f, result, name, "src/Fixed.txt"), name).toContain(
        "the fix of 5.8",
      );
    }
    expect(versionAt(f, result, "embargoed/lts/5.8.x")).toBe("5.8.30-SNAPSHOT");
    expect(versionAt(f, result, "embargoed/lts/6.4.x")).toBe("6.4.21-SNAPSHOT");
    expect(versionAt(f, result, "embargoed/lts/6.5.x")).toBe("6.5.14-SNAPSHOT");
    expect(catalogAt(f, result, "embargoed/lts/5.8.x")).toEqual({
      "spring-framework": "5.3.44",
      reactor: "2020.0.44",
      micrometer: "1.9.20",
    });
    expect(catalogAt(f, result, "embargoed/lts/6.4.x")).toEqual({
      "spring-framework": "6.1.20",
      reactor: "2022.0.20",
      micrometer: "1.12.13",
    });
    expect(catalogAt(f, result, "embargoed/lts/6.5.x")).toEqual({
      "spring-framework": "6.2.9",
      reactor: "2024.0.8",
      micrometer: "1.14.9",
    });
  });

  it("does not read the OSS repository, even if it is given one that does not exist", () => {
    const f = createFixture();
    const result = mergeTag({
      directory: f.work,
      plan: ltsPlan("5.8.30", chain),
      ossUrl: "file:///nonexistent",
    });
    expect(result.merges).toHaveLength(3);
    expect(git(f.work, "remote")).not.toContain("oss");
  });
});

describe("a hotfix", () => {
  it("has nothing to merge, and the clone is not touched", () => {
    const f = createFixture();
    const before = git(f.work, "for-each-ref");
    const result = run(f, { tag: "7.0.9.1", merge: null });
    expect(result).toEqual({
      kind: "none",
      tag: "7.0.9.1",
      branches: [],
      merges: [],
      created: { oss: [], commercial: [] },
    });
    expect(git(f.work, "for-each-ref")).toBe(before);
  });
});

describe("catalogVersions", () => {
  it("reads only the [versions] section", () => {
    expect(
      catalogVersions(
        '[versions]\na = "1"\nb-c = "2.0"\n\n[libraries]\nd = "3"\n',
      ),
    ).toEqual({ a: "1", "b-c": "2.0" });
  });
});

describe("the summary", () => {
  it("lists the merges in order, with the changes in the catalog", () => {
    const text = summaryOf(ossPlan("7.0.9", OSS_CHAIN), result, true);
    expect(text).toContain(
      "### Merges of the tag 7.0.9 (dry run: nothing is pushed)",
    );
    expect(text).toContain(
      "| 1 | OSS | `7.0.x` | tag `7.0.9` | `Merge tag '7.0.9' into 7.0.x` |",
    );
    expect(text).toContain("spring-framework 7.0.8 to 7.0.11");
    expect(text).toContain(
      "The version of gradle.properties of every branch stays as it was.",
    );
  });

  it("says that a hotfix is not merged", () => {
    expect(
      summaryOf({ tag: "7.0.9.1" }, { kind: "none", merges: [] }, false),
    ).toContain("A hotfix is not merged.");
  });
});

describe("the action", () => {
  it("merges from the files of the plan, and writes what it did", async () => {
    const f = createFixture();
    const dir = fs.mkdtempSync(path.join(f.root, "files-"));
    const planFile = path.join(dir, "plan.json");
    const mergeFile = path.join(dir, "merge.json");
    fs.writeFileSync(planFile, JSON.stringify(ossPlan("7.0.9", OSS_CHAIN)));
    const result = await runAction(
      "src/index.js",
      {
        "plan-file": planFile,
        "merge-file": mergeFile,
        path: f.work,
        "oss-url": f.oss,
      },
      { HOME: f.root },
    );
    expect(result.code).toBe(0);
    expect(result.outputs["merge-file"]).toBe(mergeFile);
    const written = JSON.parse(fs.readFileSync(mergeFile, "utf8"));
    expect(written.merges).toHaveLength(13);
    expect(result.stdout).toContain(
      "tag: Merge tag '7.0.9' into 7.0.x (merged)",
    );
  });

  it("fails with an error that GitHub shows when a file conflicts", async () => {
    const f = createFixture({ conflict: true });
    const dir = fs.mkdtempSync(path.join(f.root, "files-"));
    const planFile = path.join(dir, "plan.json");
    fs.writeFileSync(planFile, JSON.stringify(ossPlan("7.0.9", OSS_CHAIN)));
    const result = await runAction(
      "src/index.js",
      {
        "plan-file": planFile,
        "merge-file": path.join(dir, "m.json"),
        path: f.work,
        "oss-url": f.oss,
      },
      { HOME: f.root },
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("::error title=Merge conflict::");
  });
});
