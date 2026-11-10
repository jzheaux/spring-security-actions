import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { git } from "./support/git-repo.js";
import { compareWith } from "../src/report.js";
import { runAction } from "./support/run-action.js";
import {
  buildFrozen,
  buildHotfix,
  createScenario,
  pushFrozen,
} from "./support/scenario.js";

/** Runs the action in the clone of a scenario, and reads its summary. */
async function summarize(entry, world, inputs, env = {}) {
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "summary-")),
    "summary.md",
  );
  const result = await runAction(
    entry,
    { path: world.work, "oss-url": world.oss, ...inputs },
    { GITHUB_STEP_SUMMARY: file, ...env },
  );
  const text = fs.existsSync(file)
    ? world.read(fs.readFileSync(file, "utf8"))
    : undefined;
  return { result, text };
}

const frozenInputs = (world, built) => ({
  branches: built.branches,
  base: world.frozen,
  kind: "frozen",
  "oss-branch": "7.0.x",
  title: "embargoed/frozen/7.0.x",
});

const hotfixInputs = (built, more = {}) => ({
  branches: built.branches,
  base: built.pushed,
  kind: "active",
  "oss-branch": "7.0.x",
  "oss-tag": "7.0.9",
  "snapshot-of": "embargoed/7.0.9-INTERNAL-SNAPSHOT",
  "release-of": "release/7.0.9",
  "merged-snapshot": "true",
  "merged-release": "true",
  title: "embargoed/active/7.0.x",
  ...more,
});

const REF = { GITHUB_REF_NAME: "embargoed/frozen/7.0.x" };
const HOTFIX_REF = { GITHUB_REF_NAME: "embargoed/active/7.0.x" };

describe.each([["src/index.js"], ["dist/index.js"]])(
  "the summary of the program %s",
  (entry) => {
    it("says how a frozen release was created, and what OSS lacks", async () => {
      const world = createScenario();
      const built = buildFrozen(world);
      const { result, text } = await summarize(
        entry,
        world,
        frozenInputs(world, built),
        REF,
      );
      expect(result.code).toBe(0);
      expect(text).toBe(
        [
          "### embargoed/frozen/7.0.x",
          "",
          "This push creates two branches that are used for releasing 7.0.9: `embargoed/7.0.9-INTERNAL-SNAPSHOT`, the snapshot, and `release/7.0.9`, the release. They are pushed together (one atomic push).",
          "",
          "| Branch | Version | Not in OSS |",
          "| --- | --- | --- |",
          "| `embargoed/7.0.9-INTERNAL-SNAPSHOT` | 7.0.9-INTERNAL-SNAPSHOT | 2 |",
          "| `release/7.0.9` | 7.0.9 | 2 |",
          "",
          "The pushed commit is `<frozen>`. To run the commands below, in a clone of this repository, add the remotes once and fetch the branches:",
          "",
          "```shell",
          "git remote add oss <oss>",
          "git fetch oss 7.0.x --tags",
          "git fetch commercial",
          "```",
          "",
          "#### `embargoed/7.0.9-INTERNAL-SNAPSHOT`",
          "",
          "**How it was created**",
          "",
          "1. Started from the pushed commit `<frozen>` of `embargoed/frozen/7.0.x`.",
          "2. Set the version to `7.0.9-INTERNAL-SNAPSHOT` (`<internal-version>`).",
          "3. Updated 1 dependency to snapshots, with no issue: `<internal-reactor>` (reactor 2025.0.9-INTERNAL-SNAPSHOT).",
          "",
          "**Commits not in OSS `7.0.x`** (omits commits merged with -s ours)",
          "",
          "- `<internal-version>` Set the version to 7.0.9-INTERNAL-SNAPSHOT",
          "- `<internal-reactor>` Update reactor to 2025.0.9-INTERNAL-SNAPSHOT",
          "",
          "```shell",
          "git log --oneline --reverse oss/7.0.x..commercial/embargoed/7.0.9-INTERNAL-SNAPSHOT",
          "```",
          "",
          "#### `release/7.0.9`",
          "",
          "**How it was created**",
          "",
          "1. Started from the pushed commit `<frozen>` of `embargoed/frozen/7.0.x`.",
          "2. Updated 1 dependency, with its issue: `<reactor>` (reactor 2025.0.9, Closes gh-20026).",
          "3. Set the version to `7.0.9` (`<release-709>`).",
          "",
          "**Commits not in OSS `7.0.x`** (omits commits merged with -s ours)",
          "",
          "- `<reactor>` Update reactor to 2025.0.9",
          "- `<release-709>` Release 7.0.9",
          "",
          "```shell",
          "git log --oneline --reverse oss/7.0.x..commercial/release/7.0.9",
          "```",
          "",
          "**All changes in this release**",
          "",
          "3 commits since 7.0.8",
          "",
          "```shell",
          "git log --oneline --no-merges 7.0.8..commercial/release/7.0.9",
          "```",
          "",
          "",
        ].join("\n"),
      );
    });

    it("says how the two branches of a hotfix were created, each on the branch it is based on", async () => {
      const world = createScenario();
      buildFrozen(world);
      pushFrozen(world);
      const built = buildHotfix(world);
      const { result, text } = await summarize(
        entry,
        world,
        hotfixInputs(built, { train: "2026.11.19" }),
        HOTFIX_REF,
      );
      expect(result.code).toBe(0);
      expect(text).toBe(
        [
          "### embargoed/active/7.0.x",
          "",
          "This push creates two branches that are used for releasing the hotfix 7.0.9.1: `embargoed/7.0.9.1-SNAPSHOT`, the snapshot, and `release/7.0.9.1`, the release. They are pushed together (one atomic push).",
          "",
          "Release train 2026.11.19",
          "",
          "| Branch | Version | Not in the release it fixes |",
          "| --- | --- | --- |",
          "| `embargoed/7.0.9.1-SNAPSHOT` | 7.0.9.1-SNAPSHOT | 6 |",
          "| `release/7.0.9.1` | 7.0.9.1 | 7 |",
          "",
          "The pushed commit is `<header>`. To run the commands below, in a clone of this repository, add the remote once and fetch the branches:",
          "",
          "```shell",
          "git fetch commercial",
          "```",
          "",
          "#### `embargoed/7.0.9.1-SNAPSHOT`",
          "",
          "**How it was created**",
          "",
          "1. Started from the pushed commit `<header>` of `embargoed/active/7.0.x`.",
          "2. Merged `embargoed/7.0.9-INTERNAL-SNAPSHOT` into it (`<merge-snapshot>`): the hotfix snapshot is the snapshot plus the fixes.",
          "3. Applied the commercial license (`<snapshot-license>`).",
          "4. Set the version to `7.0.9.1-SNAPSHOT` (`<snapshot-version>`).",
          "5. Updated 1 dependency to snapshots from train 2026.11.19, with no issue: `<snapshot-core>` (spring-core 7.0.9.1-SNAPSHOT).",
          "",
          "**Commits not in `7.0.9`** (OSS 7.0.9 is not public yet, so compared with `embargoed/7.0.9-INTERNAL-SNAPSHOT`, the branch it is based on) (omits commits merged with -s ours)",
          "",
          "- `<cve>` Fix CVE-2026-1234 in the path matcher",
          "- `<header>` Reject a malformed header in the filter",
          "- `<merge-snapshot>` Merge embargoed/7.0.9-INTERNAL-SNAPSHOT into embargoed/7.0.9.1-SNAPSHOT",
          "- `<snapshot-license>` Commercial changes for 7.0.9.1",
          "- `<snapshot-version>` Set the version to 7.0.9.1-SNAPSHOT",
          "- `<snapshot-core>` Update spring-core to 7.0.9.1-SNAPSHOT",
          "",
          "```shell",
          "git log --oneline --reverse commercial/embargoed/7.0.9-INTERNAL-SNAPSHOT..commercial/embargoed/7.0.9.1-SNAPSHOT",
          "```",
          "",
          "#### `release/7.0.9.1`",
          "",
          "**How it was created**",
          "",
          "1. Started from the pushed commit `<header>` of `embargoed/active/7.0.x`.",
          "2. Merged `release/7.0.9` into it (`<merge-release>`): the hotfix release is the release plus the fixes.",
          "3. Applied the commercial license (`<release-license>`).",
          "4. Updated 2 dependencies from train 2026.11.19, each with its issue: `<release-core>` (spring-core 7.0.9.1, Closes gh-1234), `<release-netty>` (netty 4.2.2.1, Closes gh-1235).",
          "5. Set the version to `7.0.9.1` (`<release-7091>`).",
          "",
          "**Commits not in `7.0.9`** (OSS 7.0.9 is not public yet, so compared with `release/7.0.9`, the branch it is based on) (omits commits merged with -s ours)",
          "",
          "- `<cve>` Fix CVE-2026-1234 in the path matcher",
          "- `<header>` Reject a malformed header in the filter",
          "- `<merge-release>` Merge release/7.0.9 into release/7.0.9.1",
          "- `<release-license>` Commercial changes for 7.0.9.1",
          "- `<release-core>` Update spring-core to 7.0.9.1",
          "- `<release-netty>` Update netty to 4.2.2.1",
          "- `<release-7091>` Release 7.0.9.1",
          "",
          "```shell",
          "git log --oneline --reverse commercial/release/7.0.9..commercial/release/7.0.9.1",
          "```",
          "",
          "**All changes in this release**",
          "",
          "6 commits since 7.0.9 (7 with the 1 merge commit)",
          "",
          "```shell",
          "git log --oneline --no-merges commercial/release/7.0.9..commercial/release/7.0.9.1",
          "```",
          "",
          "",
        ].join("\n"),
      );
    });

    it("compares a hotfix with the tag of OSS once the release is public", async () => {
      const world = createScenario();
      buildFrozen(world);
      pushFrozen(world);
      // OSS has 7.0.9 now: the release that was built from the frozen commit
      git(world.work, "tag", "7.0.9", "release/7.0.9");
      git(world.work, "push", "-q", "oss", "7.0.9");
      const built = buildHotfix(world);
      const { result, text } = await summarize(
        entry,
        world,
        hotfixInputs(built),
        HOTFIX_REF,
      );
      expect(result.code).toBe(0);
      expect(text).toContain(
        "**Commits not in `7.0.9`** (omits commits merged with -s ours)",
      );
      expect(text).toContain(
        "git log --oneline --reverse 7.0.9..commercial/release/7.0.9.1",
      );
      expect(text).toContain(
        "6 commits since 7.0.9 (7 with the 1 merge commit)",
      );
      expect(text).toContain(
        "git log --oneline --no-merges 7.0.9..commercial/release/7.0.9.1",
      );
      expect(text).toContain("git remote add oss <oss>\ngit fetch oss --tags");
    });

    it("says that a merge was skipped, and compares with what the run made", async () => {
      const world = createScenario();
      // nothing was built by the frozen embargoed branch: there is nothing to merge
      const built = buildHotfix(world, { merged: false });
      const { result, text } = await summarize(
        entry,
        world,
        hotfixInputs(built, {
          "merged-snapshot": "false",
          "merged-release": "false",
        }),
        HOTFIX_REF,
      );
      expect(result.code).toBe(0);
      expect(text).toContain(
        "2. Skipped the merge: `embargoed/7.0.9-INTERNAL-SNAPSHOT` does not exist, so the hotfix snapshot is built from the active embargoed branch alone.",
      );
      expect(text).toContain(
        "2. Skipped the merge: `release/7.0.9` does not exist, so the hotfix release is built from the active embargoed branch alone.",
      );
      expect(text).toContain(
        "**Commits not in `7.0.9`** (OSS 7.0.9 is not public yet, and `release/7.0.9` does not exist, so these are the commits that the run made on the pushed commit) (omits commits merged with -s ours)",
      );
      expect(text).toContain(
        "git log --oneline --reverse <header>..commercial/release/7.0.9.1",
      );
      // 4 commits made by the run on the pushed commit: license, two updates, release
      expect(text).toContain("| `release/7.0.9.1` | 7.0.9.1 | 4 |");
    });

    it("says that the branch it is based on was in the branch already", async () => {
      const world = createScenario();
      buildFrozen(world);
      pushFrozen(world);
      const built = buildHotfix(world, { merged: false });
      const { text } = await summarize(
        entry,
        world,
        hotfixInputs(built, { "merged-release": "up-to-date" }),
        HOTFIX_REF,
      );
      expect(text).toContain(
        "2. Merged nothing: `release/7.0.9` is in the branch already.",
      );
    });

    it("compares with the commits of the run when OSS cannot be read, and goes on", async () => {
      const world = createScenario();
      const built = buildFrozen(world);
      const { result, text } = await summarize(
        entry,
        world,
        {
          ...frozenInputs(world, built),
          "oss-url": path.join(world.root, "missing.git"),
        },
        REF,
      );
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(
        "::warning title=No OSS to compare with::",
      );
      expect(text).toContain("**Commits not in OSS** (OSS could not be read: ");
      expect(text).toContain(
        "so these are the commits that the run made on the pushed commit)",
      );
      expect(text).toContain("| `release/7.0.9` | 7.0.9 | 2 |");
      // nothing from OSS is needed by the commands then
      expect(text).not.toContain("git remote add oss");
    });

    it("does not touch a tag of the clone that OSS has another of", async () => {
      const world = createScenario();
      const built = buildFrozen(world);
      // the clone has its own 7.0.8, on another commit than the one of OSS
      git(world.work, "tag", "7.0.8-clone");
      git(world.work, "tag", "-f", "7.0.8", world.frozen);
      const { result, text } = await summarize(
        entry,
        world,
        frozenInputs(world, built),
        REF,
      );
      expect(result.code).toBe(0);
      expect(result.stdout).not.toContain("::warning");
      expect(text).toContain(
        "**Commits not in OSS `7.0.x`** (omits commits merged with -s ours)",
      );
      expect(git(world.work, "rev-parse", "7.0.8")).toBe(world.frozen);
    });

    it("compares a long-term support release with the release before it, not with OSS", async () => {
      const world = createScenario();
      const built = buildFrozen(world);
      const { result, text } = await summarize(
        entry,
        world,
        { ...frozenInputs(world, built), kind: "lts" },
        REF,
      );
      expect(result.code).toBe(0);
      expect(text).toContain(
        "| Branch | Version | Not in the previous release |",
      );
      expect(text).toContain(
        "**Commits not in the previous release `7.0.8`** (omits commits merged with -s ours)",
      );
      expect(text).not.toContain("Commits not in OSS");
      expect(text).toContain(
        "git log --oneline --reverse 7.0.8..commercial/release/7.0.9",
      );
    });

    it("lists a merge, but not one made with -s ours, nor what it merged in", async () => {
      const world = createScenario();
      const built = buildFrozen(world);
      const { work } = world;
      world.start("side-ours", world.frozen);
      world.commit("Only in the ours side", "ours-side");
      world.start("side-real", world.frozen);
      fs.writeFileSync(path.join(work, "real.txt"), "real\n");
      git(work, "add", "real.txt");
      git(work, "commit", "-q", "-m", "A real change");
      world.name("real-change", git(work, "rev-parse", "HEAD"));
      git(work, "switch", "-q", "release/7.0.9");
      git(
        work,
        "merge",
        "-q",
        "--no-ff",
        "-s",
        "ours",
        "-m",
        "Merge side-ours into release/7.0.9",
        "side-ours",
      );
      world.merge(
        "side-real",
        "Merge side-real into release/7.0.9",
        "real-merge",
      );
      const { result, text } = await summarize(
        entry,
        world,
        frozenInputs(world, built),
        REF,
      );
      expect(result.code).toBe(0);
      expect(text).toContain("A real change");
      expect(text).toContain("Merge side-real into release/7.0.9");
      expect(text).not.toContain("Merge side-ours");
      expect(text).not.toContain("Only in the ours side");
      expect(text).toContain("| `release/7.0.9` | 7.0.9 | 4 |");
      expect(text).toContain(
        'git log --oneline --reverse $(for m in $(git rev-list --merges oss/7.0.x..commercial/release/7.0.9); do git diff --quiet $m^1 $m && echo "^$m^2"; done) oss/7.0.x..commercial/release/7.0.9',
      );
      // no merge made with -s ours in the snapshot: the command is a plain one
      expect(text).toContain(
        "git log --oneline --reverse oss/7.0.x..commercial/embargoed/7.0.9-INTERNAL-SNAPSHOT",
      );
    });

    it("says it when OSS has no branch for the generation", async () => {
      const world = createScenario();
      const built = buildFrozen(world);
      const { result, text } = await summarize(
        entry,
        world,
        { ...frozenInputs(world, built), "oss-branch": "9.9.x" },
        REF,
      );
      expect(result.code).toBe(0);
      expect(text).toContain(
        "**Commits not in OSS** (OSS has no branch `9.9.x`, so these are the commits that the run made on the pushed commit) (omits commits merged with -s ours)",
      );
    });

    it("lists the commits of the run on the pushed commit if it is not told where OSS is", async () => {
      const world = createScenario();
      const built = buildFrozen(world);
      const { result, text } = await summarize(
        entry,
        world,
        {
          branches: built.branches,
          base: world.frozen,
          "oss-url": "",
        },
        REF,
      );
      expect(result.code).toBe(0);
      expect(text).toContain(
        "**Commits on the pushed commit** (omits commits merged with -s ours)",
      );
      expect(text).toContain(
        "git log --oneline --reverse <frozen>..commercial/release/7.0.9",
      );
    });

    it("shows 50 commits and says how many more, with a link to the compare view", async () => {
      const world = createScenario();
      world.start("release/7.0.9", world.frozen);
      for (let i = 1; i <= 53; i++) {
        world.commit(`Change ${i}`);
      }
      const { result, text } = await summarize(
        entry,
        world,
        {
          branches: "release/7.0.9=7.0.9",
          base: world.frozen,
          kind: "frozen",
          "oss-branch": "7.0.x",
        },
        { ...REF, GITHUB_REPOSITORY: "acme/widgets" },
      );
      expect(result.code).toBe(0);
      expect(text).toContain(
        "| `release/7.0.9` | 7.0.9 | 53 |".replace(
          "`release/7.0.9`",
          "[`release/7.0.9`](https://github.com/acme/widgets/tree/release/7.0.9)",
        ),
      );
      expect(text.match(/^- \[`/gm)).toHaveLength(50);
      expect(text).toContain(
        "- [and 3 more](https://github.com/acme/widgets/compare/<frozen>...release/7.0.9)",
      );
      // the command has no limit
      expect(text).toContain(
        "git log --oneline --reverse oss/7.0.x..commercial/release/7.0.9",
      );
    });

    it("links the commits and the branches when the repository is known, and escapes the subjects", async () => {
      const world = createScenario();
      world.start("release/7.0.9", world.frozen);
      world.commit(
        "Fix [a link](https://example.com) | <b>bold</b> *star* `code` _under_",
        "odd",
      );
      const { result, text } = await summarize(
        entry,
        world,
        {
          branches: "release/7.0.9=7.0.9",
          base: world.frozen,
          kind: "frozen",
          "oss-branch": "7.0.x",
          "milestone-url": "https://github.com/acme/widgets/milestone/12",
          train: "2026.11.19",
          "train-status": "joined",
          "train-state": "pending",
          "train-state-url":
            "https://github.com/acme/train/blob/2026.11.19/train.yml#L1",
          "train-url": "https://github.com/acme/train/tree/2026.11.19",
        },
        {
          ...REF,
          GITHUB_SERVER_URL: "https://github.example.com/",
          GITHUB_REPOSITORY: "acme/widgets",
        },
      );
      expect(result.code).toBe(0);
      expect(text).toContain(
        "This push creates the branch [`release/7.0.9`](https://github.example.com/acme/widgets/tree/release/7.0.9).",
      );
      expect(text).toContain(
        "[Release train 2026.11.19](https://github.com/acme/train/tree/2026.11.19) is [pending](https://github.com/acme/train/blob/2026.11.19/train.yml#L1): joined, not ready yet",
      );
      expect(text).toContain(
        "| [`release/7.0.9`](https://github.example.com/acme/widgets/tree/release/7.0.9) | [7.0.9](https://github.com/acme/widgets/milestone/12) | 1 |",
      );
      expect(text).toContain(
        "- [`<odd>`](https://github.example.com/acme/widgets/commit/<odd>) Fix \\[a link\\](https://example.com) \\| \\<b\\>bold\\</b\\> \\*star\\* \\`code\\` \\_under\\_",
      );
      expect(text).toContain(
        "The pushed commit is [`<frozen>`](https://github.example.com/acme/widgets/commit/<frozen>).",
      );
    });

    it("shows a commit that the actions do not make as it is", async () => {
      const world = createScenario();
      world.start("release/7.0.9", world.frozen);
      world.commit("Something by hand", "hand");
      const { text } = await summarize(
        entry,
        world,
        { branches: "release/7.0.9=7.0.9", base: world.frozen, kind: "frozen" },
        REF,
      );
      expect(text).toContain("2. `<hand>` Something by hand");
    });
  },
);

describe("compareWith for a long-term support branch", () => {
  const args = {
    directory: ".",
    role: "release",
    kind: "lts",
    remote: "origin",
    base: "0123456789abcdef",
    oss: {},
  };

  it("says the release before it", () => {
    const result = compareWith({
      ...args,
      previous: {
        version: "5.8.29",
        gitRef: "refs/tags/5.8.29",
        commandRef: "5.8.29",
        oss: false,
      },
    });
    expect(result.heading).toBe(
      "**Commits not in the previous release `5.8.29`** (omits commits merged with -s ours)",
    );
    expect(result.commandRef).toBe("5.8.29");
  });

  it("falls back to the pushed commit when there is no release before it", () => {
    const result = compareWith(args);
    expect(result.gitRef).toBe("0123456789abcdef");
    expect(result.heading).toContain(
      "(there is none, so these are the commits that the run made",
    );
  });
});
