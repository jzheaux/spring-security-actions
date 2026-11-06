import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as core from "@actions/core";
import { git } from "./git.js";
import { execute, isMain } from "./run.js";
import { addSummary, table } from "./summary.js";

/**
 * The branches to back up from the lines of the input. A name that is not a branch, that
 * has refs/heads/ in front, or that is there twice is an error.
 */
export function parseBranches(text) {
  const branches = (text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (branches.length === 0) {
    throw new Error("The input branches is required: one branch per line");
  }
  for (const branch of branches) {
    if (branch.startsWith("refs/")) {
      throw new Error(
        `"${branch}" is not a branch name: leave out refs/heads/`,
      );
    }
    try {
      git(".", "", "check-ref-format", `refs/heads/${branch}`);
    } catch {
      throw new Error(`"${branch}" is not a valid branch name`);
    }
  }
  const twice = branches.find((b, i) => branches.indexOf(b) !== i);
  if (twice) {
    throw new Error(`The branch ${twice} is in the input twice`);
  }
  return branches;
}

function server() {
  return (process.env.GITHUB_SERVER_URL || "https://github.com").replace(
    /\/+$/,
    "",
  );
}

/** The URL of a repository to read from: GITHUB_SERVER_URL, so a test can use another. */
export function repositoryUrl(repository) {
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository ?? "")) {
    throw new Error(`"${repository}" is not a repository: expected owner/repo`);
  }
  return `${server()}/${repository}.git`;
}

/**
 * The URL that a restore pushes to: the one of GitHub that a person uses (ssh), and the
 * same as the one that is read from for any other server.
 */
export function restoreUrl(repository) {
  return server() === "https://github.com"
    ? `git@github.com:${repository}.git`
    : repositoryUrl(repository);
}

/** The commands that put the branches back, from inside the backup. */
export function restoreCommands(repository, backedUp) {
  return backedUp.map(
    ({ branch, commit }) =>
      `git push ${restoreUrl(repository)} ${commit}:refs/heads/${branch}`,
  );
}

/**
 * Backs up branches: a new git repository in the directory, with only those branches
 * fetched, and nothing else. The token is the credentials of the requests only (an
 * http.extraheader given through the environment), so it is in no file of the backup: the
 * backup is uploaded and downloaded, and has the history of the branches. A branch that
 * does not exist is skipped. It returns { backedUp: [{ branch, commit }], missing } and
 * the directory has a RESTORE.md with the commands that put the branches back.
 */
export function backupBranches({ repository, branches, token, directory }) {
  const url = repositoryUrl(repository);
  if (fs.existsSync(directory) && fs.readdirSync(directory).length > 0) {
    throw new Error(`The directory ${directory} exists, and is not empty`);
  }
  const listed = git(os.tmpdir(), token, "ls-remote", "--heads", url);
  const existing = new Set(
    listed
      .split("\n")
      .map((line) => line.split("\t")[1]?.replace(/^refs\/heads\//, ""))
      .filter(Boolean),
  );
  const missing = branches.filter((b) => !existing.has(b));
  const present = branches.filter((b) => existing.has(b));
  if (present.length === 0) {
    return { backedUp: [], missing };
  }
  fs.mkdirSync(directory, { recursive: true });
  git(directory, token, "init", "-q");
  git(directory, token, "remote", "add", "origin", restoreUrl(repository));
  git(
    directory,
    token,
    "fetch",
    "--quiet",
    url,
    ...present.map((b) => `refs/heads/${b}:refs/heads/${b}`),
  );
  const backedUp = present.map((branch) => ({
    branch,
    commit: git(directory, token, "rev-parse", `refs/heads/${branch}`),
  }));
  fs.writeFileSync(
    path.join(directory, "RESTORE.md"),
    [
      "# Restore the branches",
      "",
      `These branches of ${repository} were backed up before they were deleted. From inside this directory, push the ones to restore:`,
      "",
      "```",
      ...restoreCommands(repository, backedUp),
      "```",
      "",
    ].join("\n"),
  );
  return { backedUp, missing };
}

export async function main() {
  const repository = core.getInput("repository", { required: true });
  const token = core.getInput("token", { required: true });
  core.setSecret(token);
  const name = core.getInput("name", { required: true });
  const directory =
    core.getInput("directory") ||
    path.join(process.env.RUNNER_TEMP || os.tmpdir(), name);
  const { backedUp, missing } = backupBranches({
    repository,
    branches: parseBranches(core.getInput("branches")),
    token,
    directory,
  });
  const lines = [`### Back-up of the branches to delete in ${repository}`, ""];
  if (backedUp.length > 0) {
    lines.push(
      table(
        ["Branch", "Commit"],
        backedUp.map(({ branch, commit }) => [
          `\`${branch}\``,
          commit.slice(0, 7),
        ]),
      ),
      "",
      `Download the artifact \`${name}\`, unzip it, and from inside it:`,
      "",
      "```",
      ...restoreCommands(repository, backedUp),
      "```",
    );
  } else {
    lines.push("There is nothing to back up: none of the branches exists.");
  }
  if (missing.length > 0) {
    lines.push("", `Not found: ${missing.map((b) => `\`${b}\``).join(", ")}.`);
  }
  addSummary(lines.join("\n"));
  core.setOutput("directory", directory);
  core.setOutput("name", name);
  core.setOutput("count", String(backedUp.length));
  core.setOutput(
    "branches",
    backedUp.map(({ branch, commit }) => `${branch}=${commit}`).join("\n"),
  );
  core.setOutput("missing", missing.join("\n"));
  for (const { branch, commit } of backedUp) {
    core.info(`Backed up ${branch} (${commit.slice(0, 7)}) in ${directory}`);
  }
}

if (isMain(import.meta.url)) {
  execute(main);
}
