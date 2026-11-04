import fs from "node:fs";
import path from "node:path";
import * as core from "@actions/core";
import { git } from "./git.js";
import { execute, isMain, TitledError } from "./run.js";

export const DEFAULT_APPLY_FILE = "code-freeze/apply.json";
export const DEFAULT_PUSH_FILE = "code-freeze/push.json";

const lines = (text) => text.split("\n").filter(Boolean);

/**
 * The tripwire that nothing from the commercial repository reaches OSS. It does not trust how
 * the branches were made: it looks at what the push of each OSS branch would send, the commits
 * that the OSS remote does not have, and fails unless every one of them
 *
 * - is a commit that the freeze made (the apply step lists them),
 * - is not in the commercial repository (a commit that the commercial branches have and OSS
 *   does not, as they were fetched),
 * - has no `embargoed` in its message (the name of an embargoed branch is private),
 * - is either a version commit that changes gradle.properties and nothing else, or a merge of
 *   two commits that are both in OSS: in its history already, or made by the freeze.
 *
 * It returns { problems, commits }: what is wrong, and how many commits would be pushed.
 */
export function checkNothingCommercialInOss({
  directory,
  apply,
  commercialRemote = "origin",
  ossRemote = "oss",
}) {
  const problems = [];
  const created = new Set(apply.created.oss);
  // what only the commercial repository has: its remote branches and the branches of the clone
  const commercialOnly = new Set(
    lines(
      git(
        directory,
        "rev-list",
        `--remotes=${commercialRemote}`,
        "--branches",
        "--not",
        `--remotes=${ossRemote}`,
      ),
    ),
  );
  const inOss = (commit) =>
    git(
      directory,
      "rev-list",
      "-1",
      commit,
      "--not",
      `--remotes=${ossRemote}`,
    ) === "";
  const pushed = new Set();
  for (const branch of apply.branches.filter((b) => b.repository === "oss")) {
    const commits = lines(
      git(directory, "rev-list", branch.ref, "--not", `--remotes=${ossRemote}`),
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
        problems.push(`${describe} was not made by the freeze`);
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
      if (parents.length === 1) {
        const files = lines(
          git(
            directory,
            "diff-tree",
            "--no-commit-id",
            "--name-only",
            "-r",
            commit,
          ),
        );
        if (files.join(",") !== "gradle.properties") {
          problems.push(
            `${describe} changes ${files.join(", ") || "nothing"}, and a version commit changes only gradle.properties`,
          );
        }
      } else if (parents.length === 2) {
        for (const parent of parents) {
          if (!created.has(parent) && !inOss(parent)) {
            problems.push(
              `${describe} has the parent ${parent.slice(0, 7)}, which is not in OSS and was not made by the freeze`,
            );
          }
        }
      } else {
        problems.push(`${describe} has ${parents.length} parents`);
      }
    }
  }
  return { problems, commits: pushed.size };
}

/** The refspecs of a push: the branches of a repository whose work ref moved. Never a force. */
export function refspecsOf(apply, repository) {
  return apply.branches
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
 * Checks, and then pushes, the branches of a code freeze:
 *
 * - `check`: the tripwire, and a push that is only tried (`--dry-run`) to both remotes, to see
 *   that it would be accepted. Nothing is pushed.
 * - `push`: the tripwire again, and then the commercial repository, and then OSS, each in one
 *   atomic push without force (a branch that is not a fast forward is refused, and none of that
 *   push is made). The commercial one is first: nothing public changes until it worked. If OSS is
 *   refused after it, the error says what is left to push by hand.
 *
 * It returns what was done, for the summary.
 */
export function pushFreeze({
  directory,
  apply,
  mode,
  commercialRemote = "origin",
  ossRemote = "oss",
}) {
  if (!["check", "push"].includes(mode)) {
    throw new Error(`The mode is check or push, and not ${mode}`);
  }
  const result = {
    mode,
    commercial: { remote: commercialRemote, branches: [], pushed: false },
    oss: { remote: ossRemote, branches: [], pushed: false },
    leakCheck: { problems: [], commits: 0 },
  };
  const leak = checkNothingCommercialInOss({
    directory,
    apply,
    commercialRemote,
    ossRemote,
  });
  result.leakCheck = leak;
  if (leak.problems.length > 0) {
    const error = new TitledError(
      "Commercial code would reach OSS",
      `Nothing was pushed. The OSS branches of the freeze have commits that must not go to OSS:\n- ${leak.problems.join("\n- ")}`,
    );
    error.result = result;
    throw error;
  }
  const commercial = refspecsOf(apply, "commercial");
  const oss = refspecsOf(apply, "oss");
  result.commercial.branches = commercial.map(({ branch, sha }) => ({
    branch,
    sha,
  }));
  result.oss.branches = oss.map(({ branch, sha }) => ({ branch, sha }));
  const dryRun = mode === "check";
  try {
    if (commercial.length > 0) {
      push(directory, commercialRemote, commercial, { dryRun });
      result.commercial.pushed = !dryRun;
    }
  } catch (error) {
    error.message = `Pushing the commercial branches ${dryRun ? "would be refused" : "was refused"}, and nothing was pushed: ${error.message}`;
    error.result = result;
    throw error;
  }
  try {
    if (oss.length > 0) {
      push(directory, ossRemote, oss, { dryRun });
      result.oss.pushed = !dryRun;
    }
  } catch (error) {
    const left = oss.map((r) => `${r.sha}:refs/heads/${r.branch}`).join(" ");
    error.message = dryRun
      ? `Pushing the OSS branches would be refused, and nothing was pushed: ${error.message}`
      : `${result.commercial.pushed ? "The commercial branches were pushed, and the" : "The"} OSS branches were refused: ${error.message}\nTo finish it by hand, from a clone that has these commits: git push --atomic <the OSS repository> ${left}`;
    error.result = result;
    throw error;
  }
  return result;
}

export async function main() {
  const applyFile =
    core.getInput("apply-file") ||
    path.join(process.env.RUNNER_TEMP ?? process.cwd(), DEFAULT_APPLY_FILE);
  const pushFile =
    core.getInput("push-file") ||
    path.join(process.env.RUNNER_TEMP ?? process.cwd(), DEFAULT_PUSH_FILE);
  const mode = core.getInput("mode", { required: true });
  const apply = JSON.parse(fs.readFileSync(applyFile, "utf8"));
  const write = (result) => {
    fs.mkdirSync(path.dirname(pushFile), { recursive: true });
    fs.writeFileSync(pushFile, `${JSON.stringify(result, null, 2)}\n`);
    core.setOutput("push-file", pushFile);
  };
  let result;
  try {
    result = pushFreeze({
      directory: core.getInput("path") || ".",
      apply,
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
  core.info(
    `${mode === "check" ? "Would push" : "Pushed"} ${result.commercial.branches.length} commercial and ${result.oss.branches.length} OSS branches; the OSS branches have ${result.leakCheck.commits} new commits, none of them commercial`,
  );
}

if (isMain(import.meta.url)) {
  execute(main);
}
