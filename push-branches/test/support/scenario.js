import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { git } from "./git-repo.js";

/**
 * A world like the one of the release workflow: the OSS repository (a branch 7.0.x, and a tag
 * 7.0.8), the repository that runs the workflow (origin), and the clone of the workflow, which
 * is checked out with the branches of origin. The commit "Frozen" is the head of 7.0.x
 * when the release is built, which the branches of the release are started at.
 *
 * `commit(message)` commits in the clone, on the branch that is checked out, and returns the
 * commit. `names` is what the summary has to be read with: a sha is replaced by the name that it
 * was given (`name(label, sha)`).
 */
export function createScenario() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scenario-"));
  const oss = path.join(root, "oss.git");
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  git(root, "init", "-q", "--bare", "-b", "7.0.x", oss);
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  fs.mkdirSync(work);
  git(work, "init", "-q", "-b", "7.0.x");
  git(work, "config", "user.name", "Alice");
  git(work, "config", "user.email", "alice@example.com");
  git(work, "config", "commit.gpgsign", "false");
  git(work, "remote", "add", "oss", oss);
  git(work, "remote", "add", "origin", origin);

  const names = {};
  const name = (label, sha) => {
    names[label] = sha;
    return sha;
  };
  // every commit has a time of its own: two empty commits of the same message and parent are
  // otherwise the same commit
  let seconds = 1_700_000_000;
  const timed = (...args) => {
    const date = `${(seconds += 60)} +0000`;
    return execFileSync("git", args, {
      cwd: work,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date,
      },
    });
  };
  // every commit changes a file of its own, so that a merge of branches brings content in (a
  // merge of empty commits has the tree of its first parent, as one made with -s ours has)
  let files = 0;
  const commit = (message, label) => {
    fs.writeFileSync(path.join(work, `change-${++files}.txt`), `${message}\n`);
    timed("add", "-A");
    timed("commit", "-q", "--allow-empty", "-m", message);
    const sha = git(work, "rev-parse", "HEAD");
    if (label) {
      name(label, sha);
    }
    return sha;
  };
  const merge = (branch, message, label) => {
    timed("merge", "-q", "--no-ff", "-m", message, branch);
    return name(label, git(work, "rev-parse", "HEAD"));
  };
  const start = (branch, from) => git(work, "switch", "-q", "-C", branch, from);

  commit("Initial commit", "initial");
  commit("Fix the thing", "fix-7.0.8");
  git(work, "tag", "7.0.8");
  commit("Polish");
  const frozen = name("frozen", git(work, "rev-parse", "HEAD"));
  git(work, "push", "-q", "oss", "7.0.x", "--tags");

  /** What the summary says, with the shas as the names that they were given, and no paths. */
  const read = (summary) => {
    let text = summary.split(oss).join("<oss>");
    for (const [label, sha] of Object.entries(names)) {
      for (const length of [40, 10, 7]) {
        text = text.split(sha.slice(0, length)).join(`<${label}>`);
      }
    }
    return text;
  };
  return { root, oss, origin, work, commit, merge, start, name, read, frozen };
}

/**
 * The branches of a frozen embargoed branch, built as the workflow does: the snapshot
 * (a version, and a snapshot of a dependency) and the release (a dependency with its issue,
 * and the version of the release), both started at the pushed commit, which they are pushed
 * from. It leaves the clone on the release.
 */
export function buildFrozen(world, pushed = world.frozen) {
  world.start("embargoed/7.0.9-INTERNAL-SNAPSHOT", pushed);
  world.commit(
    "Set the version to 7.0.9-INTERNAL-SNAPSHOT",
    "internal-version",
  );
  world.commit(
    "Update reactor to 2025.0.9-INTERNAL-SNAPSHOT",
    "internal-reactor",
  );
  world.start("release/7.0.9", pushed);
  world.commit("Update reactor to 2025.0.9\n\nCloses gh-20026", "reactor");
  world.commit("Release 7.0.9", "release-709");
  return {
    branches:
      "release/7.0.9=7.0.9\nembargoed/7.0.9-INTERNAL-SNAPSHOT=7.0.9-INTERNAL-SNAPSHOT",
  };
}

/**
 * The branches of a hotfix of that release, built as the workflow does: the active embargoed
 * branch has two fixes after the frozen one; the snapshot has the snapshot of the release merged
 * in, and the release has the release merged in. Both are pushed from the pushed commit, the
 * second fix. It needs buildFrozen to have been done and pushed to origin.
 */
export function buildHotfix(world, { merged = true } = {}) {
  world.start("embargoed/active/7.0.x", world.frozen);
  world.commit("Fix CVE-2026-1234 in the path matcher", "cve");
  const pushed = world.commit(
    "Reject a malformed header in the filter",
    "header",
  );

  world.start("embargoed/7.0.9.1-SNAPSHOT", pushed);
  if (merged) {
    world.merge(
      "origin/embargoed/7.0.9-INTERNAL-SNAPSHOT",
      "Merge embargoed/7.0.9-INTERNAL-SNAPSHOT into embargoed/7.0.9.1-SNAPSHOT",
      "merge-snapshot",
    );
  }
  world.commit("Commercial changes for 7.0.9.1", "snapshot-license");
  world.commit("Set the version to 7.0.9.1-SNAPSHOT", "snapshot-version");
  world.commit("Update spring-core to 7.0.9.1-SNAPSHOT", "snapshot-core");

  world.start("release/7.0.9.1", pushed);
  if (merged) {
    world.merge(
      "origin/release/7.0.9",
      "Merge release/7.0.9 into release/7.0.9.1",
      "merge-release",
    );
  }
  world.commit("Commercial changes for 7.0.9.1", "release-license");
  world.commit(
    "Update spring-core to 7.0.9.1\n\nCloses gh-1234",
    "release-core",
  );
  world.commit("Update netty to 4.2.2.1\n\nCloses gh-1235", "release-netty");
  world.commit("Release 7.0.9.1", "release-7091");
  return {
    pushed,
    branches:
      "release/7.0.9.1=7.0.9.1\nembargoed/7.0.9.1-SNAPSHOT=7.0.9.1-SNAPSHOT",
  };
}

/** Pushes what the frozen embargoed branch built to origin, as the workflow did before. */
export function pushFrozen(world) {
  git(
    world.work,
    "push",
    "-q",
    "origin",
    "release/7.0.9",
    "embargoed/7.0.9-INTERNAL-SNAPSHOT",
  );
}
