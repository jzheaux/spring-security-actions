import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as core from "@actions/core";
import { git, gitTry } from "./git.js";
import { execute, isMain } from "./run.js";
import { addSummary, table } from "./summary.js";

/**
 * The branches to delete, from the lines of the input. A name that is not a branch,
 * that has refs/heads/ in front, or that is there twice is an error: nothing is
 * deleted on a guess.
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
    if (
      gitTry(".", "", "check-ref-format", `refs/heads/${branch}`).code !== 0
    ) {
      throw new Error(`"${branch}" is not a valid branch name`);
    }
  }
  const twice = branches.find((b, i) => branches.indexOf(b) !== i);
  if (twice) {
    throw new Error(`The branch ${twice} is in the input twice`);
  }
  return branches;
}

/** The URL of a repository to push to: GITHUB_SERVER_URL, so a test can use another. */
export function repositoryUrl(repository) {
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository ?? "")) {
    throw new Error(`"${repository}" is not a repository: expected owner/repo`);
  }
  const server = (
    process.env.GITHUB_SERVER_URL || "https://github.com"
  ).replace(/\/+$/, "");
  return `${server}/${repository}.git`;
}

/**
 * Deletes the branches of a repository at once, or none: git push --atomic --delete, which
 * GitHub applies as one transaction. It first reads the branches of the repository. A branch
 * that does not exist is skipped (it is gone already, so a run can be repeated), and the rest
 * are deleted in one push. It refuses, deleting nothing, if one of them is the default
 * branch, and fails, deleting nothing, if GitHub refuses the push for one of them.
 * With dryRun nothing is deleted, and the result says what would be.
 *
 * It returns { rows, deleted, missing, problem, dryRun }: for every branch what happened
 * (deleted, would be deleted, not found, not deleted or default branch), the branches that
 * were (or would be) deleted, the ones that do not exist, and why it failed (the problem is
 * undefined if it did not).
 */
export function deleteBranches({
  repository,
  branches,
  token,
  dryRun = false,
}) {
  const url = repositoryUrl(repository);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "delete-"));
  try {
    git(directory, token, "init", "-q");
    const head = git(directory, token, "ls-remote", "--symref", url, "HEAD");
    const defaultBranch = /^ref: refs\/heads\/(\S+)\s+HEAD/m.exec(head)?.[1];
    const existing = new Set(
      git(directory, token, "ls-remote", "--heads", url)
        .split("\n")
        .map((line) => line.split("\t")[1]?.replace(/^refs\/heads\//, ""))
        .filter(Boolean),
    );
    const missing = branches.filter((b) => !existing.has(b));
    const toDelete = branches.filter((b) => existing.has(b));
    const rowsFor = (result) =>
      branches.map((branch) => ({
        branch,
        result: missing.includes(branch) ? "not found" : result,
      }));
    if (toDelete.includes(defaultBranch)) {
      return {
        rows: rowsFor("not deleted").map((row) =>
          row.branch === defaultBranch
            ? { ...row, result: "default branch" }
            : row,
        ),
        deleted: [],
        missing,
        problem: `${defaultBranch} is the default branch of ${repository}, which is not deleted`,
        dryRun,
      };
    }
    if (toDelete.length === 0 || dryRun) {
      return {
        rows: rowsFor("would be deleted"),
        deleted: dryRun ? toDelete : [],
        missing,
        dryRun,
      };
    }
    const pushed = gitTry(
      directory,
      token,
      "push",
      "--atomic",
      url,
      "--delete",
      ...toDelete.map((b) => `refs/heads/${b}`),
    );
    if (pushed.code !== 0) {
      return {
        rows: rowsFor("not deleted"),
        deleted: [],
        missing,
        problem: `The push was refused: ${pushed.stderr}`,
        dryRun,
      };
    }
    return { rows: rowsFor("deleted"), deleted: toDelete, missing, dryRun };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * The cell of a branch in the summary: its name, linked to the branch on GitHub unless
 * it was deleted.
 */
export function branchCell(repository, { branch, result }) {
  const name = `\`${branch}\``;
  if (result !== "not deleted" && result !== "default branch") {
    return name;
  }
  const server = (
    process.env.GITHUB_SERVER_URL || "https://github.com"
  ).replace(/\/+$/, "");
  const encoded = branch.split("/").map(encodeURIComponent).join("/");
  return `[${name}](${server}/${repository}/tree/${encoded})`;
}

/** The line under the table of the summary. */
function conclusion({ rows, deleted, missing, problem, dryRun }) {
  if (problem) {
    return `Nothing was deleted: ${problem}`;
  }
  const noun = (n) => `${n} ${n === 1 ? "branch" : "branches"}`;
  const notFound =
    missing.length > 0
      ? `, ${noun(missing.length)} not found (gone already)`
      : "";
  if (deleted.length === 0 && !dryRun) {
    return `Nothing to delete: ${noun(rows.length)} not found (gone already)`;
  }
  return `${noun(deleted.length)} ${dryRun ? "would be deleted" : "deleted"}, atomically${notFound}`;
}

export async function main() {
  const repository = core.getInput("repository", { required: true });
  const token = core.getInput("token", { required: true });
  core.setSecret(token);
  const dryRun = core.getInput("dry-run").trim().toLowerCase() === "true";
  const branches = parseBranches(core.getInput("branches"));
  const result = deleteBranches({ repository, branches, token, dryRun });
  addSummary(
    [
      `### Delete branches in ${repository}${dryRun ? " (dry run)" : ""}`,
      "",
      table(
        ["Branch", "Result"],
        result.rows.map((row) => [branchCell(repository, row), row.result]),
      ),
      "",
      conclusion(result),
    ].join("\n"),
  );
  if (result.problem) {
    throw new Error(`Nothing was deleted: ${result.problem}`);
  }
  core.setOutput("deleted", result.deleted.join("\n"));
  core.setOutput("missing", result.missing.join("\n"));
  for (const branch of result.deleted) {
    core.info(
      `${dryRun ? "Would delete" : "Deleted"} ${branch} of ${repository}`,
    );
  }
  for (const branch of result.missing) {
    core.info(`${branch} of ${repository} does not exist: skipped`);
  }
}

if (isMain(import.meta.url)) {
  execute(main);
}
