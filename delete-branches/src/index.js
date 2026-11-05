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
 * GitHub applies as one transaction. It first reads the branches of the repository, and
 * refuses, deleting nothing, if one of them does not exist or is the default branch.
 * It returns { rows, problem }: for every branch what happened, and why it failed (the
 * problem is undefined if the branches were deleted).
 */
export function deleteBranches({ repository, branches, token }) {
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
    const isDefault = branches.filter((b) => b === defaultBranch);
    const refused = (result, problem) => ({
      rows: branches.map((branch) => ({
        branch,
        result: missing.includes(branch)
          ? "not found"
          : isDefault.includes(branch)
            ? "default branch"
            : result,
      })),
      problem,
    });
    if (isDefault.length > 0) {
      return refused(
        "not deleted",
        `${isDefault[0]} is the default branch of ${repository}, which is not deleted`,
      );
    }
    if (missing.length > 0) {
      return refused(
        "not deleted",
        `${missing.join(", ")} ${missing.length === 1 ? "does" : "do"} not exist in ${repository}`,
      );
    }
    const pushed = gitTry(
      directory,
      token,
      "push",
      "--atomic",
      url,
      "--delete",
      ...branches.map((b) => `refs/heads/${b}`),
    );
    if (pushed.code !== 0) {
      return {
        rows: branches.map((branch) => ({ branch, result: "not deleted" })),
        problem: `The push was refused: ${pushed.stderr}`,
      };
    }
    return {
      rows: branches.map((branch) => ({ branch, result: "deleted" })),
    };
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

export async function main() {
  const repository = core.getInput("repository", { required: true });
  const token = core.getInput("token", { required: true });
  core.setSecret(token);
  const branches = parseBranches(core.getInput("branches"));
  const { rows, problem } = deleteBranches({ repository, branches, token });
  addSummary(
    [
      `### Delete branches in ${repository}`,
      "",
      table(
        ["Branch", "Result"],
        rows.map((row) => [branchCell(repository, row), row.result]),
      ),
      "",
      problem
        ? `Nothing was deleted: ${problem}`
        : `${rows.length} ${rows.length === 1 ? "branch" : "branches"} deleted, atomically`,
    ].join("\n"),
  );
  if (problem) {
    throw new Error(`Nothing was deleted: ${problem}`);
  }
  core.setOutput("deleted", branches.join("\n"));
  for (const branch of branches) {
    core.info(`Deleted ${branch} of ${repository}`);
  }
}

if (isMain(import.meta.url)) {
  execute(main);
}
