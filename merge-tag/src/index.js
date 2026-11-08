import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as core from "@actions/core";
import { authenticate, git, gitTry, requireIdentity } from "./git.js";
import { TitledError, execute, isMain } from "./run.js";
import { addSummary, table } from "./summary.js";

export const DEFAULT_PLAN_FILE = "post-publish/plan.json";
export const DEFAULT_MERGE_FILE = "post-publish/merge.json";

// The branches of the OSS repository are worked on in this namespace, and the ones of the
// commercial repository in the other: no OSS branch is ever the commercial branch of the same
// name (main is a branch of both). The tag is in a ref of its own.
export const OSS_NAMESPACE = "refs/post-publish/oss";
export const COMMERCIAL_NAMESPACE = "refs/post-publish/commercial";
export const TAG_REF = "refs/post-publish/tag";
const ossRef = (branch) => `${OSS_NAMESPACE}/${branch}`;
const commercialRef = (branch) => `${COMMERCIAL_NAMESPACE}/${branch}`;

const PROPERTIES = "gradle.properties";
const CATALOG = "gradle/libs.versions.toml";

/** What git printed for a command, exactly (no newline is taken off), or undefined if it failed. */
function gitRaw(directory, ...args) {
  try {
    return execFileSync("git", args, {
      cwd: directory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
}

/** The entries `name = "value"` of the [versions] section of a version catalog. */
export function catalogVersions(text) {
  const versions = {};
  let inVersions = false;
  for (const line of (text ?? "").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      inVersions = trimmed === "[versions]";
      continue;
    }
    const match = /^([A-Za-z0-9_.-]+)\s*=\s*"([^"]*)"/.exec(trimmed);
    if (inVersions && match) {
      versions[match[1]] = match[2];
    }
  }
  return versions;
}

/**
 * A merge does the work of a normal merge, and settles the two files that carry versions:
 *
 * - gradle.properties is restored from one side, whether it conflicts or not: a merge never
 *   decides the version of a branch.
 * - the version catalog is merged, and where both sides changed the same lines, one side is
 *   preferred, as the lines of that side are the ones to keep.
 *
 * Any other conflict fails the run, with the merge undone: it is for a person to merge.
 */
class Merger {
  constructor(directory) {
    this.directory = directory;
    this.created = { oss: [], commercial: [] };
    this.merges = [];
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

  /** Whether the commit is in the history of HEAD already. */
  contains(source) {
    return (
      gitTry(this.directory, "merge-base", "--is-ancestor", source, "HEAD")
        .code === 0
    );
  }

  /**
   * Resolves the conflicts of the version catalog in favour of one side (`ours` is the branch
   * that is checked out, `theirs` what is merged into it), and leaves the other hunks as they
   * were merged. It does nothing if the catalog has no conflict, or if one side deleted it.
   */
  resolveCatalog(side) {
    const unmerged = this.git("diff", "--name-only", "--diff-filter=U")
      .split("\n")
      .filter(Boolean);
    if (!unmerged.includes(CATALOG)) {
      return;
    }
    const base = gitRaw(this.directory, "show", `:1:${CATALOG}`) ?? "";
    const ours = gitRaw(this.directory, "show", `:2:${CATALOG}`);
    const theirs = gitRaw(this.directory, "show", `:3:${CATALOG}`);
    if (ours === undefined || theirs === undefined) {
      return;
    }
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-"));
    try {
      fs.writeFileSync(path.join(work, "ours"), ours);
      fs.writeFileSync(path.join(work, "base"), base);
      fs.writeFileSync(path.join(work, "theirs"), theirs);
      const merged = gitTry(
        work,
        "merge-file",
        "-p",
        `--${side}`,
        "ours",
        "base",
        "theirs",
      );
      if (merged.code !== 0) {
        return;
      }
      // the output of gitTry has its last newline taken off
      fs.writeFileSync(
        path.join(this.directory, CATALOG),
        `${merged.stdout}\n`,
      );
      this.git("add", "--", CATALOG);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }

  /**
   * Merges a branch (or the tag) into the one that is checked out. `properties` and `catalog`
   * say which side wins: `target` (the branch that is checked out) or `source`. If the source
   * is in the history already, nothing is merged. It is a merge commit even if it could be
   * fast forwarded to. It returns { outcome: "merged", commit, catalog } or
   * { outcome: "up-to-date" }, where catalog is what the merge changed in the [versions]
   * of the version catalog.
   */
  merge({ source, message, repository, properties, catalog }) {
    if (/embargoed/i.test(message)) {
      throw new Error(`The message "${message}" names an embargoed branch`);
    }
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
    const keep = properties === "target" ? "HEAD" : source;
    if (
      gitTry(this.directory, "cat-file", "-e", `${keep}:${PROPERTIES}`).code ===
      0
    ) {
      this.git("checkout", keep, "--", PROPERTIES);
    }
    this.resolveCatalog(catalog === "target" ? "ours" : "theirs");
    const unresolved = this.git("diff", "--name-only", "--diff-filter=U")
      .split("\n")
      .filter(Boolean);
    if (unresolved.length > 0) {
      this.git("merge", "--abort");
      throw new TitledError(
        "Merge conflict",
        `Merging ${source} into the branch at ${target} conflicts in ${unresolved.join(", ")}: merge it by hand, and run it again. Nothing was pushed.`,
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
    this.created[repository].push(commit);
    const before = catalogVersions(
      gitRaw(this.directory, "show", `${target}:${CATALOG}`),
    );
    const after = catalogVersions(
      gitRaw(this.directory, "show", `${commit}:${CATALOG}`),
    );
    return {
      outcome: "merged",
      commit,
      catalog: Object.keys(after)
        .filter((key) => before[key] !== after[key])
        .map((key) => ({ key, from: before[key] ?? null, to: after[key] })),
    };
  }
}

/**
 * Fetches what the merges read: the OSS branches of the chain and, unless a ref stands in for
 * it (a dry run before the tag exists, which is not in OSS), the tag of the release.
 */
function fetchOss({ directory, plan, ossRemote, ossUrl }) {
  const remotes = git(directory, "remote").split("\n");
  if (remotes.includes(ossRemote)) {
    git(directory, "remote", "set-url", ossRemote, ossUrl);
  } else {
    git(directory, "remote", "add", ossRemote, ossUrl);
  }
  git(
    directory,
    "fetch",
    "--quiet",
    "--no-tags",
    ossRemote,
    ...plan.merge.branches.map(
      (b) => `+refs/heads/${b.branch}:refs/remotes/${ossRemote}/${b.branch}`,
    ),
    ...(plan.merge.ref ? [] : [`+refs/tags/${plan.tag}:${TAG_REF}`]),
  );
}

/**
 * The commit that the plan recorded for the ref, from the commercial repository, in the ref of
 * the tag: the merges read it as they read the tag. The commit is fetched by its name if the
 * clone does not have it, so a branch that moved since the plan changes nothing.
 */
function fetchCommercialRef({ directory, plan, commercialRemote }) {
  const { sha } = plan.merge.ref;
  const local = gitTry(
    directory,
    "rev-parse",
    "--verify",
    "--quiet",
    `${sha}^{commit}`,
  );
  if (local.code !== 0) {
    git(
      directory,
      "fetch",
      "--quiet",
      "--no-tags",
      commercialRemote,
      `+${sha}:${TAG_REF}`,
    );
    return;
  }
  git(directory, "update-ref", TAG_REF, local.stdout);
}

function fetchCommercialTag({ directory, plan, commercialRemote }) {
  const local = gitTry(
    directory,
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/tags/${plan.tag}`,
  );
  if (local.code === 0) {
    git(directory, "update-ref", TAG_REF, local.stdout);
    return;
  }
  git(
    directory,
    "fetch",
    "--quiet",
    "--no-tags",
    commercialRemote,
    `+refs/tags/${plan.tag}:${TAG_REF}`,
  );
}

/**
 * Merges the tag of a release that was made public into its branch, and then forward, in the
 * clone of the commercial repository. Nothing is pushed.
 *
 * An OSS release: the OSS branches are done first, from the OSS repository alone: the tag into
 * the first branch of the chain, and then each branch into the next (across). Then each
 * generation of the commercial repository: its frozen branch merges the frozen one before it
 * (across) and the OSS branch (down), and its active branch merges the active one before it
 * (across) and its frozen branch (down). A long-term support release is merged through the
 * embargoed/lts branches only, and the OSS repository is never fetched.
 *
 * gradle.properties is the one of the branch that is merged into (the tag into a branch,
 * across), or of the source (down). The version catalog is the one of the tag (the tag into a
 * branch), of the target (across) or of the source (down), where the two sides conflict. A
 * branch that has the source in its history already is not merged, so a run can be repeated.
 *
 * A dry run before the tag exists gives `plan.merge.ref` (a name and the commit that the plan
 * found): that commit, from the commercial repository for both kinds, is merged where the tag
 * would be, with the message of the tag, and nothing of OSS is read for the tag.
 *
 * It returns what was done, for the summary and for the push: the work refs of the branches
 * before and after, the merges, and the commits that were created in each repository.
 */
export function mergeTag({
  directory,
  plan,
  ossUrl,
  commercialRemote = "origin",
  ossRemote = "oss",
}) {
  if (!plan.merge) {
    return {
      kind: "none",
      tag: plan.tag,
      branches: [],
      merges: [],
      created: { oss: [], commercial: [] },
    };
  }
  const kind = plan.merge.kind;
  requireIdentity(directory);
  if (git(directory, "status", "--porcelain")) {
    throw new Error(
      `The working tree of ${path.resolve(directory)} is not clean, and the merges need a clean one`,
    );
  }
  if (kind === "oss") {
    fetchOss({ directory, plan, ossRemote, ossUrl });
  }
  if (plan.merge.ref) {
    fetchCommercialRef({ directory, plan, commercialRemote });
  } else if (kind !== "oss") {
    fetchCommercialTag({ directory, plan, commercialRemote });
  }
  const tagCommit = git(directory, "rev-parse", `${TAG_REF}^{commit}`);
  git(directory, "update-ref", TAG_REF, tagCommit);

  const merger = new Merger(directory);
  const branches = [];
  const start = (repository, branch, from, ref) => {
    if (
      gitTry(directory, "rev-parse", "--verify", "--quiet", from).code !== 0
    ) {
      throw new Error(`${from} does not exist in the clone`);
    }
    git(directory, "update-ref", ref, from);
    branches.push({
      repository,
      branch,
      ref,
      before: git(directory, "rev-parse", ref),
    });
  };
  const record = (mergeKind, repository, source, into, message, result) =>
    merger.merges.push({
      kind: mergeKind,
      repository,
      source,
      into,
      message,
      ...result,
    });

  const chain = plan.merge.branches;
  if (kind === "oss") {
    for (const g of chain) {
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
    chain.forEach((g, i) => {
      merger.checkout(ossRef(g.branch));
      const previous = chain[i - 1];
      const message = previous
        ? `Merge branch '${previous.branch}' into ${g.branch}`
        : `Merge tag '${plan.tag}' into ${g.branch}`;
      record(
        previous ? "across" : "tag",
        "oss",
        previous ? previous.branch : plan.tag,
        g.branch,
        message,
        merger.merge({
          source: previous ? ossRef(previous.branch) : TAG_REF,
          message,
          repository: "oss",
          properties: "target",
          catalog: previous ? "target" : "source",
        }),
      );
      merger.save(ossRef(g.branch));
    });
    chain.forEach((g, i) => {
      const previous = chain[i - 1];
      const down = `Merge branch '${g.branch}' into ${g.branch}`;
      for (const [name, source, before] of [
        [g.frozen, ossRef(g.branch), previous?.frozen],
        [g.active, commercialRef(g.frozen), previous?.active],
      ]) {
        merger.checkout(commercialRef(name));
        if (before) {
          const message = `Merge branch '${previous.branch}' into ${g.branch}`;
          record(
            "across",
            "commercial",
            before,
            name,
            message,
            merger.merge({
              source: commercialRef(before),
              message,
              repository: "commercial",
              properties: "target",
              catalog: "target",
            }),
          );
        }
        record(
          "down",
          "commercial",
          source === ossRef(g.branch) ? g.branch : g.frozen,
          name,
          down,
          merger.merge({
            source,
            message: down,
            repository: "commercial",
            properties: "source",
            catalog: "source",
          }),
        );
        merger.save(commercialRef(name));
      }
    });
  } else {
    for (const g of chain) {
      start(
        "commercial",
        g.branch,
        `refs/remotes/${commercialRemote}/${g.branch}`,
        commercialRef(g.branch),
      );
    }
    chain.forEach((g, i) => {
      merger.checkout(commercialRef(g.branch));
      const previous = chain[i - 1];
      const message = previous
        ? `Merge branch '${previous.generation}' into ${g.generation}`
        : `Merge tag '${plan.tag}' into ${g.generation}`;
      record(
        previous ? "across" : "tag",
        "commercial",
        previous ? previous.branch : plan.tag,
        g.branch,
        message,
        merger.merge({
          source: previous ? commercialRef(previous.branch) : TAG_REF,
          message,
          repository: "commercial",
          properties: "target",
          catalog: previous ? "target" : "source",
        }),
      );
      merger.save(commercialRef(g.branch));
    });
  }

  const after = (b) => git(directory, "rev-parse", b.ref);
  return {
    kind,
    tag: plan.tag,
    tagCommit,
    ref: plan.merge.ref ?? null,
    branches: branches.map((b) => ({
      ...b,
      after: after(b),
      changed: after(b) !== b.before,
    })),
    merges: merger.merges,
    created: merger.created,
  };
}

/** The summary of the merges: in order, with what each changed in the version catalog. */
export function summaryOf(plan, result, dryRun) {
  const lines = [
    `### Merges of the tag ${plan.tag}${dryRun ? " (dry run: nothing is pushed)" : ""}`,
    "",
  ];
  if (result.kind === "none") {
    lines.push("A hotfix is not merged.");
    return lines.join("\n");
  }
  const rows = result.merges.map((m, i) => [
    i + 1,
    m.repository === "oss" ? "OSS" : "commercial",
    `\`${m.into}\``,
    m.kind === "tag"
      ? result.ref
        ? `ref \`${result.ref.name}\` (stands in for the tag)`
        : `tag \`${m.source}\``
      : `\`${m.source}\` (${m.kind})`,
    `\`${m.message}\``,
    m.outcome === "merged"
      ? (m.catalog ?? [])
          .map((c) => `${c.key} ${c.from ?? "none"} to ${c.to}`)
          .join(", ") || "none"
      : "up to date, nothing merged",
  ]);
  lines.push(
    table(
      [
        "#",
        "Repository",
        "Into",
        "From",
        "Message",
        "Changes in the versions of the catalog",
      ],
      rows,
    ),
    "",
    "The version of gradle.properties of every branch stays as it was.",
  );
  return lines.join("\n");
}

export async function main() {
  const planFile =
    core.getInput("plan-file") ||
    path.join(process.env.RUNNER_TEMP ?? process.cwd(), DEFAULT_PLAN_FILE);
  const mergeFile =
    core.getInput("merge-file") ||
    path.join(process.env.RUNNER_TEMP ?? process.cwd(), DEFAULT_MERGE_FILE);
  const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
  const token = core.getInput("token");
  if (token) {
    core.setSecret(token);
  }
  authenticate(token);
  const server = (
    process.env.GITHUB_SERVER_URL || "https://github.com"
  ).replace(/\/+$/, "");
  const result = mergeTag({
    directory: core.getInput("path") || ".",
    plan,
    ossUrl: core.getInput("oss-url") || `${server}/${plan.ossRepository}.git`,
    commercialRemote: core.getInput("commercial-remote") || "origin",
    ossRemote: core.getInput("oss-remote") || "oss",
  });
  fs.mkdirSync(path.dirname(mergeFile), { recursive: true });
  fs.writeFileSync(mergeFile, `${JSON.stringify(result, null, 2)}\n`);
  core.setOutput("merge-file", mergeFile);
  for (const m of result.merges) {
    core.info(`${m.kind}: ${m.message} (${m.outcome})`);
  }
  addSummary(
    summaryOf(
      plan,
      result,
      core.getInput("dry-run").trim().toLowerCase() === "true",
    ),
  );
}

if (isMain(import.meta.url)) {
  execute(main);
}
