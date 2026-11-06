import fs from "node:fs";
import path from "node:path";
import * as core from "@actions/core";
import { authenticate, git, gitTry } from "./git.js";
import { TitledError, execute, isMain } from "./run.js";
import { addSummary, table } from "./summary.js";

export const DEFAULT_MERGE_FILE = "post-publish/merge.json";
export const DEFAULT_PUSH_FILE = "post-publish/push.json";

// The tag of the release is in a ref of this namespace (merge-tag put it there), and it came
// from OSS for an OSS release: what it has is public.
export const TAG_REF = "refs/post-publish/tag";

const lines = (text) => text.split("\n").filter(Boolean);

/**
 * The tripwire that nothing from the commercial repository reaches OSS. It does not trust how
 * the branches were made: it looks at what the push of each OSS branch would send, the commits
 * that OSS does not have (its branches, as they were fetched, and the tag of the release, which
 * came from it), and fails unless every one of them
 *
 * - is a commit that merge-tag made,
 * - is not in the commercial repository (a commit that its branches have and OSS does not),
 * - has no `embargoed` in its message (the name of an embargoed branch is private),
 * - is a merge of two commits that are both in OSS: in its history already, or made by merge-tag.
 *
 * It returns { problems, commits }: what is wrong, and how many commits would be pushed.
 */
export function checkNothingCommercialInOss({
  directory,
  merge,
  commercialRemote = "origin",
  ossRemote = "oss",
}) {
  const problems = [];
  const created = new Set(merge.created.oss);
  const hasTag =
    merge.kind === "oss" &&
    gitTry(directory, "rev-parse", "--verify", "--quiet", TAG_REF).code === 0;
  // what OSS has: its branches that were fetched, and the tag that came from it
  const publicRefs = [`--remotes=${ossRemote}`, ...(hasTag ? [TAG_REF] : [])];
  // what only the commercial repository has: its remote branches and the branches of the clone
  const commercialOnly = new Set(
    lines(
      git(
        directory,
        "rev-list",
        `--remotes=${commercialRemote}`,
        "--branches",
        "--not",
        ...publicRefs,
      ),
    ),
  );
  const inOss = (commit) =>
    git(directory, "rev-list", "-1", commit, "--not", ...publicRefs) === "";
  const pushed = new Set();
  for (const branch of merge.branches.filter((b) => b.repository === "oss")) {
    const commits = lines(
      git(directory, "rev-list", branch.ref, "--not", ...publicRefs),
    );
    for (const commit of commits) {
      if (pushed.has(commit)) {
        continue;
      }
      pushed.add(commit);
      const short = commit.slice(0, 7);
      const subject = git(directory, "log", "-1", "--format=%s", commit);
      const describe = `${short} "${subject}" (to ${branch.branch})`;
      if (commercialOnly.has(commit)) {
        problems.push(`${describe} is in the commercial repository`);
      }
      if (!created.has(commit)) {
        problems.push(`${describe} was not made by the merges of the tag`);
        continue;
      }
      if (
        /embargoed/i.test(git(directory, "log", "-1", "--format=%B", commit))
      ) {
        problems.push(`${describe} has embargoed in its message`);
      }
      const parents = git(directory, "log", "-1", "--format=%P", commit)
        .split(" ")
        .filter(Boolean);
      if (parents.length !== 2) {
        problems.push(
          `${describe} has ${parents.length} parents, and only a merge goes to OSS`,
        );
        continue;
      }
      for (const parent of parents) {
        if (!created.has(parent) && !inOss(parent)) {
          problems.push(
            `${describe} has the parent ${parent.slice(0, 7)}, which is not in OSS and was not made by the merges of the tag`,
          );
        }
      }
    }
  }
  return { problems, commits: pushed.size };
}

/** The refspecs of a push: the branches of a repository whose work ref moved. Never a force. */
export function refspecsOf(merge, repository) {
  return merge.branches
    .filter((b) => b.repository === repository && b.changed)
    .map((b) => ({
      branch: b.branch,
      sha: b.after,
      refspec: `${b.ref}:refs/heads/${b.branch}`,
    }));
}

function push(directory, remote, refspecs, { dryRun }) {
  for (const { refspec } of refspecs) {
    if (refspec.startsWith("+")) {
      throw new Error(`${refspec} would be a forced push`);
    }
  }
  const args = ["push", "--atomic", "--porcelain"];
  if (dryRun) {
    args.push("--dry-run");
  }
  args.push(remote, ...refspecs.map((r) => r.refspec));
  return git(directory, ...args);
}

/**
 * Checks, and then pushes, the branches that the tag was merged into:
 *
 * - `check`: the tripwire, and a push that is only tried (`--dry-run`) to both remotes, to see
 *   that it would be accepted. Nothing is pushed.
 * - `push`: the tripwire again, and then OSS, and then the commercial repository, each in one
 *   atomic push without force (a branch that is not a fast forward is refused, and none of that
 *   push is made). OSS is first, as what it gets is the tag, which is public, and merges of it.
 *   If the commercial repository is refused after it, the error says what is left to push by
 *   hand, and a run that is made again does not merge what is merged.
 *
 * A long-term support release, and a hotfix, never push to OSS: an OSS branch in the merges
 * of one is an error.
 *
 * It returns what was done, for the summary.
 */
export function pushMerges({
  directory,
  merge,
  mode,
  commercialRemote = "origin",
  ossRemote = "oss",
}) {
  if (!["check", "push"].includes(mode)) {
    throw new Error(`The mode is check or push, and not ${mode}`);
  }
  const result = {
    mode,
    tag: merge.tag,
    oss: { remote: ossRemote, branches: [], pushed: false },
    commercial: { remote: commercialRemote, branches: [], pushed: false },
    leakCheck: { problems: [], commits: 0 },
  };
  if (
    merge.kind !== "oss" &&
    merge.branches.some((b) => b.repository === "oss")
  ) {
    const error = new TitledError(
      "Commercial code would reach OSS",
      `Nothing was pushed. The merges of ${merge.tag}, which is not an OSS release, have OSS branches, and only an OSS release goes to OSS`,
    );
    error.result = result;
    throw error;
  }
  if (merge.kind === "oss") {
    result.leakCheck = checkNothingCommercialInOss({
      directory,
      merge,
      commercialRemote,
      ossRemote,
    });
  }
  if (result.leakCheck.problems.length > 0) {
    const error = new TitledError(
      "Commercial code would reach OSS",
      `Nothing was pushed. The OSS branches have commits that must not go to OSS:\n- ${result.leakCheck.problems.join("\n- ")}`,
    );
    error.result = result;
    throw error;
  }
  const oss = refspecsOf(merge, "oss");
  const commercial = refspecsOf(merge, "commercial");
  result.oss.branches = oss.map(({ branch, sha }) => ({ branch, sha }));
  result.commercial.branches = commercial.map(({ branch, sha }) => ({
    branch,
    sha,
  }));
  const dryRun = mode === "check";
  try {
    if (oss.length > 0) {
      push(directory, ossRemote, oss, { dryRun });
      result.oss.pushed = !dryRun;
    }
  } catch (error) {
    error.message = `Pushing the OSS branches ${dryRun ? "would be refused" : "was refused"}, and nothing was pushed: ${error.message}`;
    error.result = result;
    throw error;
  }
  try {
    if (commercial.length > 0) {
      push(directory, commercialRemote, commercial, { dryRun });
      result.commercial.pushed = !dryRun;
    }
  } catch (error) {
    const left = commercial
      .map((r) => `${r.sha}:refs/heads/${r.branch}`)
      .join(" ");
    error.message = dryRun
      ? `Pushing the commercial branches would be refused, and nothing was pushed: ${error.message}`
      : `${result.oss.pushed ? "The OSS branches were pushed, and the" : "The"} commercial branches were refused: ${error.message}\nTo finish it by hand, from a clone that has these commits: git push --atomic <the commercial repository> ${left}\nRun it again once that is settled: a branch that has the tag already is not merged again.`;
    error.result = result;
    throw error;
  }
  return result;
}

/** The summary of the pushes: the branches, OSS first, and what the tripwire looked at. */
export function summaryOf(result) {
  const dryRun = result.mode === "check";
  const verb = dryRun ? "would be pushed" : "pushed";
  const rows = [
    ...result.oss.branches.map((b) => ["OSS", b]),
    ...result.commercial.branches.map((b) => ["commercial", b]),
  ].map(([repository, b]) => [
    repository,
    `\`${b.branch}\``,
    b.sha.slice(0, 7),
    verb,
  ]);
  const out = [
    `### Pushes of the merges of ${result.tag}${dryRun ? " (dry run)" : ""}`,
    "",
  ];
  if (rows.length > 0) {
    out.push(table(["Repository", "Branch", "Commit", "Result"], rows), "");
  } else {
    out.push("Nothing to push: every branch has the tag already.", "");
  }
  if (result.oss.branches.length > 0) {
    out.push(
      `The OSS check: ${result.leakCheck.commits} commits ${dryRun ? "would be" : "were"} sent to OSS, all merges whose parents are in OSS.`,
    );
  }
  if (dryRun && rows.length > 0) {
    out.push(
      "A push of each repository with `--atomic --dry-run` was accepted.",
    );
  }
  return out.join("\n");
}

export async function main() {
  const mergeFile =
    core.getInput("merge-file") ||
    path.join(process.env.RUNNER_TEMP ?? process.cwd(), DEFAULT_MERGE_FILE);
  const pushFile =
    core.getInput("push-file") ||
    path.join(process.env.RUNNER_TEMP ?? process.cwd(), DEFAULT_PUSH_FILE);
  const mode = core.getInput("mode", { required: true });
  const merge = JSON.parse(fs.readFileSync(mergeFile, "utf8"));
  const token = core.getInput("token");
  if (token) {
    core.setSecret(token);
  }
  authenticate(token);
  const write = (result) => {
    fs.mkdirSync(path.dirname(pushFile), { recursive: true });
    fs.writeFileSync(pushFile, `${JSON.stringify(result, null, 2)}\n`);
    core.setOutput("push-file", pushFile);
  };
  let result;
  try {
    result = pushMerges({
      directory: core.getInput("path") || ".",
      merge,
      mode,
      commercialRemote: core.getInput("commercial-remote") || "origin",
      ossRemote: core.getInput("oss-remote") || "oss",
    });
  } catch (error) {
    if (error.result) {
      write(error.result);
    }
    throw error;
  }
  write(result);
  if (core.getInput("summary").trim().toLowerCase() !== "false") {
    addSummary(summaryOf(result));
  }
  core.info(
    `${mode === "check" ? "Would push" : "Pushed"} ${result.oss.branches.length} OSS and ${result.commercial.branches.length} commercial branches; the OSS branches have ${result.leakCheck.commits} new commits, none of them commercial`,
  );
}

if (isMain(import.meta.url)) {
  execute(main);
}
