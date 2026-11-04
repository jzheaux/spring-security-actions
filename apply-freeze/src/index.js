import fs from "node:fs";
import path from "node:path";
import * as core from "@actions/core";
import { git, gitTry, requireIdentity } from "./git.js";
import { execute, isMain, TitledError } from "./run.js";

export const DEFAULT_APPLY_FILE = "code-freeze/apply.json";
export const DEFAULT_PLAN_FILE = "code-freeze/plan.json";

// The branches of the OSS repository are worked on in this namespace, and the ones of the
// commercial repository in the other: no OSS branch is ever the commercial branch of the same
// name (main is a branch of both). They start as the branches of the remotes, fetched.
export const OSS_NAMESPACE = "refs/freeze/oss";
export const COMMERCIAL_NAMESPACE = "refs/freeze/commercial";
const ossRef = (branch) => `${OSS_NAMESPACE}/${branch}`;
const commercialRef = (branch) => `${COMMERCIAL_NAMESPACE}/${branch}`;

const VERSION_LINE = /^version=([^\r\n]*)/m;
const PROPERTIES = "gradle.properties";

/**
 * A freeze works on a detached HEAD, one branch after the other, and keeps the result of each
 * in its namespace: nothing of a branch of the clone is changed, and nothing is pushed here.
 */
class Freeze {
  constructor(directory) {
    this.directory = directory;
    this.created = { oss: [], commercial: [] };
    this.merges = [];
    this.bumps = [];
    this.rotation = [];
  }

  git(...args) {
    return git(this.directory, ...args);
  }

  checkout(ref) {
    this.git("checkout", "--quiet", "--detach", ref);
  }

  head() {
    return this.git("rev-parse", "HEAD");
  }

  /** Records the work on a branch: the ref of its namespace is where HEAD is. */
  save(ref) {
    this.git("update-ref", ref, "HEAD");
  }

  record(repository, commit) {
    this.created[repository].push(commit);
  }

  /** Whether the commit is in the history of HEAD already. */
  contains(source) {
    return (
      gitTry(this.directory, "merge-base", "--is-ancestor", source, "HEAD")
        .code === 0
    );
  }

  /**
   * Merges a branch into the one that is checked out, without committing, and settles
   * gradle.properties: the version is the one of `keep` (a ref). A merge never decides a
   * version. Any other file that both sides changed is a conflict that fails the freeze, with the
   * merge undone. It is a merge commit even if the branch could be fast forwarded to. If the
   * branch is in the history already, nothing is merged.
   *
   * It returns { outcome: "merged", commit } or { outcome: "up-to-date" }.
   */
  merge({ source, message, keep, repository }) {
    if (this.contains(source)) {
      return { outcome: "up-to-date" };
    }
    const target = this.head();
    const merging = gitTry(
      this.directory,
      "merge",
      "--no-commit",
      "--no-ff",
      "--quiet",
      source,
    );
    const mergeHead = gitTry(
      this.directory,
      "rev-parse",
      "--verify",
      "--quiet",
      "MERGE_HEAD",
    );
    if (mergeHead.code !== 0) {
      throw new Error(
        `Merging ${source} into ${target} failed: ${merging.stderr || merging.stdout}`,
      );
    }
    // the version is not a conflict, whatever the two sides did to it
    if (
      gitTry(this.directory, "cat-file", "-e", `${keep}:${PROPERTIES}`).code ===
      0
    ) {
      this.git("checkout", keep, "--", PROPERTIES);
    }
    const unresolved = this.git("diff", "--name-only", "--diff-filter=U")
      .split("\n")
      .filter(Boolean);
    if (unresolved.length > 0) {
      this.git("merge", "--abort");
      throw new TitledError(
        "Merge conflict",
        `Merging ${source} into the branch at ${target} conflicts in ${unresolved.join(", ")}: merge it by hand, and run the code freeze again. Nothing was pushed.`,
      );
    }
    this.git(
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "--signoff",
      "--message",
      message,
    );
    const commit = this.head();
    this.record(repository, commit);
    return { outcome: "merged", commit };
  }

  /**
   * A merge across, into the next generation: the version of the target stays (HEAD, before it
   * was merged).
   */
  across({ source, message, repository }) {
    return this.merge({ source, message, keep: "HEAD", repository });
  }

  /** A merge down, into the branch that is embargoed: the version is the one of the source. */
  down({ source, message, repository }) {
    return this.merge({ source, message, keep: source, repository });
  }

  /**
   * Sets the version of gradle.properties, in a commit of its own that is signed off, as
   * set-version does. Only the line version=... changes.
   */
  bump({ version, message, repository }) {
    const full = path.join(this.directory, PROPERTIES);
    const text = fs.readFileSync(full, "utf8");
    const current = VERSION_LINE.exec(text);
    if (!current) {
      throw new Error(`${PROPERTIES} has no line version=...`);
    }
    if (current[1] === version) {
      throw new Error(`${PROPERTIES} has the version ${version} already`);
    }
    fs.writeFileSync(
      full,
      text.replace(VERSION_LINE, () => `version=${version}`),
    );
    this.git("add", "--", PROPERTIES);
    this.git(
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "--signoff",
      "--message",
      message,
      "--",
      PROPERTIES,
    );
    const commit = this.head();
    this.record(repository, commit);
    return { from: current[1], commit };
  }

  /** Fast forwards the checked out branch to another. It fails if it cannot. */
  fastForward(source) {
    const result = gitTry(
      this.directory,
      "merge",
      "--ff-only",
      "--quiet",
      source,
    );
    if (result.code !== 0) {
      throw new TitledError(
        "Not a fast forward",
        `The frozen branch at ${this.head()} cannot be fast forwarded to the active branch at ${this.git("rev-parse", source)}: ${result.stderr || result.stdout}. Nothing was pushed.`,
      );
    }
  }
}

const mergeMessage = (source, target) =>
  `merge(ours): ${source} into ${target}`;
// A merge into an embargoed branch is public once the branch is: it names no embargoed branch.
const downMessage = (generation) =>
  `Merge branch '${generation}' into ${generation}`;
const bumpMessage = (version) => `Next Development Version (${version})`;

/**
 * Makes the merges and the version commits of a code freeze, locally. The order is the one
 * that keeps the commercial code out of OSS: the OSS branches are done first, from the OSS
 * remote alone, and then the embargoed ones, which read the finished OSS branches.
 *
 * 1. OSS, from the oldest to the newest: the branch before it is merged across (the version
 *    stays), and then the version commit.
 * 2. For each generation: its frozen branch merges the frozen one before it across, and then the
 *    OSS branch down (the version of the OSS branch); its active branch merges the active one
 *    before it across, and then the frozen branch down.
 * 3. The long-term support branches, from the oldest to the newest: the one before it across
 *    (the version stays), and then the version commit.
 * 4. Each frozen branch is fast forwarded to the active one: the rotation.
 *
 * A branch whose version does not change gets no version commit, and is merged all the same.
 *
 * It returns what was done, for the summary and for the push: the work refs of the branches
 * before and after, the merges, and the commits that were created in each repository.
 */
export function applyFreeze({
  directory,
  plan,
  commercialRemote = "origin",
  ossRemote = "oss",
}) {
  const freeze = new Freeze(directory);
  requireIdentity(directory);
  if (git(directory, "status", "--porcelain")) {
    throw new Error(
      `The working tree of ${path.resolve(directory)} is not clean, and the freeze needs a clean one`,
    );
  }

  const branches = []; // { repository, branch, ref, before }
  const start = (repository, branch, from, ref) => {
    git(directory, "update-ref", ref, from);
    branches.push({
      repository,
      branch,
      ref,
      before: git(directory, "rev-parse", ref),
    });
  };
  for (const g of plan.oss) {
    start(
      "oss",
      g.branch,
      `refs/remotes/${ossRemote}/${g.branch}`,
      ossRef(g.branch),
    );
    for (const name of [g.frozen, g.active]) {
      start(
        "commercial",
        name,
        `refs/remotes/${commercialRemote}/${name}`,
        commercialRef(name),
      );
    }
  }
  for (const g of plan.lts) {
    start(
      "commercial",
      g.branch,
      `refs/remotes/${commercialRemote}/${g.branch}`,
      commercialRef(g.branch),
    );
  }

  // the branch that is being worked on: the one that a merge is into
  let into;
  const merge = (kind, repository, source, target, outcome, message) =>
    freeze.merges.push({
      kind,
      repository,
      source,
      target,
      into,
      message,
      ...outcome,
    });
  const bump = (repository, name, ref, g) => {
    if (!g.bump) {
      return;
    }
    const result = freeze.bump({
      version: g.next,
      message: bumpMessage(g.next),
      repository,
    });
    freeze.bumps.push({
      branch: name,
      from: result.from,
      to: g.next,
      commit: result.commit,
    });
  };

  // 1. OSS
  plan.oss.forEach((g, i) => {
    into = g.branch;
    freeze.checkout(ossRef(g.branch));
    const previous = plan.oss[i - 1];
    if (previous) {
      const message = mergeMessage(previous.branch, g.branch);
      merge(
        "across",
        "oss",
        previous.branch,
        g.branch,
        freeze.across({
          source: ossRef(previous.branch),
          message,
          repository: "oss",
        }),
        message,
      );
    }
    bump("oss", g.branch, ossRef(g.branch), g);
    freeze.save(ossRef(g.branch));
  });

  // 2. frozen and active
  plan.oss.forEach((g, i) => {
    const previous = plan.oss[i - 1];
    const down = downMessage(g.branch);
    for (const [name, source, before] of [
      [g.frozen, ossRef(g.branch), previous?.frozen],
      [g.active, commercialRef(g.frozen), previous?.active],
    ]) {
      into = name;
      freeze.checkout(commercialRef(name));
      if (before) {
        const message = mergeMessage(previous.branch, g.branch);
        merge(
          "across",
          "commercial",
          previous.branch,
          g.branch,
          freeze.across({
            source: commercialRef(before),
            message,
            repository: "commercial",
          }),
          message,
        );
      }
      merge(
        "down",
        "commercial",
        g.branch,
        g.branch,
        freeze.down({ source, message: down, repository: "commercial" }),
        down,
      );
      freeze.save(commercialRef(name));
    }
  });

  // 3. long-term support
  plan.lts.forEach((g, i) => {
    into = g.branch;
    freeze.checkout(commercialRef(g.branch));
    const previous = plan.lts[i - 1];
    if (previous) {
      const message = mergeMessage(previous.generation, g.generation);
      merge(
        "across",
        "commercial",
        previous.generation,
        g.generation,
        freeze.across({
          source: commercialRef(previous.branch),
          message,
          repository: "commercial",
        }),
        message,
      );
    }
    bump("commercial", g.branch, commercialRef(g.branch), g);
    freeze.save(commercialRef(g.branch));
  });

  // 4. the rotation: the frozen branch is the active one
  for (const g of plan.oss) {
    freeze.checkout(commercialRef(g.frozen));
    const from = freeze.head();
    freeze.fastForward(commercialRef(g.active));
    freeze.save(commercialRef(g.frozen));
    freeze.rotation.push({
      branch: g.frozen,
      active: g.active,
      from,
      to: freeze.head(),
    });
  }

  const after = (b) => git(directory, "rev-parse", b.ref);
  return {
    branches: branches.map((b) => ({
      ...b,
      after: after(b),
      changed: after(b) !== b.before,
    })),
    merges: freeze.merges,
    bumps: freeze.bumps,
    rotation: freeze.rotation,
    created: freeze.created,
  };
}

export async function main() {
  const planFile =
    core.getInput("plan-file") ||
    path.join(process.env.RUNNER_TEMP ?? process.cwd(), DEFAULT_PLAN_FILE);
  const applyFile =
    core.getInput("apply-file") ||
    path.join(process.env.RUNNER_TEMP ?? process.cwd(), DEFAULT_APPLY_FILE);
  const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
  if (plan.problems?.length > 0) {
    throw new Error(`The plan ${planFile} has problems: nothing is applied`);
  }
  const result = applyFreeze({
    directory: core.getInput("path") || ".",
    plan,
    commercialRemote: core.getInput("commercial-remote") || "origin",
    ossRemote: core.getInput("oss-remote") || "oss",
  });
  fs.mkdirSync(path.dirname(applyFile), { recursive: true });
  fs.writeFileSync(applyFile, `${JSON.stringify(result, null, 2)}\n`);
  core.setOutput("apply-file", applyFile);
  for (const m of result.merges) {
    core.info(`${m.kind}: ${m.message} (${m.outcome})`);
  }
  for (const b of result.bumps) {
    core.info(`${b.branch}: ${b.from} to ${b.to}`);
  }
  for (const r of result.rotation) {
    core.info(`${r.branch} fast forwarded to ${r.active}`);
  }
}

if (isMain(import.meta.url)) {
  execute(main);
}
