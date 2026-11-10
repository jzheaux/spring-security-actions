import fs from "node:fs";
import * as core from "@actions/core";

/**
 * Adds markdown to the summary of the step (the file named by GITHUB_STEP_SUMMARY). Run
 * locally, where there is no such file, it prints the markdown instead.
 */
export function addSummary(markdown) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) {
    fs.appendFileSync(file, `${markdown}\n`);
  } else {
    core.info(markdown);
  }
}

/** A markdown table from a header and rows, each a list of cells. */
export function table(header, rows) {
  const line = (cells) => `| ${cells.join(" | ")} |`;
  return [line(header), line(header.map(() => "---")), ...rows.map(line)].join(
    "\n",
  );
}

/**
 * The text as it is shown, in markdown: the characters that mean something (a link, a code
 * span, emphasis, a table cell, a tag) are escaped. The subject of a commit is the text of
 * somebody else.
 */
export function escapeMarkdown(text) {
  return String(text).replace(/([\\`*_[\]<>|])/g, "\\$1");
}

/**
 * The address of the repository that runs the workflow (GITHUB_SERVER_URL, GITHUB_REPOSITORY),
 * without a slash at the end. Undefined when it is not known, run locally for example: the
 * summary then has no links.
 */
export function repositoryUrl() {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) {
    return undefined;
  }
  const server = (
    process.env.GITHUB_SERVER_URL || "https://github.com"
  ).replace(/\/+$/, "");
  return `${server}/${repository}`;
}

/**
 * The names that the commands of the summary give to the remotes of a clone: the commercial
 * repository (this one) and OSS, whatever the clone calls them (origin), so that the commands
 * are the same for everybody.
 */
export const COMMERCIAL_REMOTE = "commercial";
export const OSS_REMOTE = "oss";

/** A sha as a short code, linked to its commit when the repository is known. */
export function commitLink(sha) {
  const short = `\`${sha.slice(0, 7)}\``;
  const repository = repositoryUrl();
  return repository ? `[${short}](${repository}/commit/${sha})` : short;
}

/**
 * The cell of a branch in the summary: its name, linked to the branch on GitHub when the
 * repository is known (GITHUB_REPOSITORY), and plain otherwise.
 */
export function branchCell(branch) {
  const name = `\`${branch}\``;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) {
    return name;
  }
  const server = (
    process.env.GITHUB_SERVER_URL || "https://github.com"
  ).replace(/\/+$/, "");
  const encoded = branch.split("/").map(encodeURIComponent).join("/");
  return `[${name}](${server}/${repository}/tree/${encoded})`;
}

/**
 * The cell of a version in the summary: linked to the milestone of the release, if there
 * is one. A snapshot version (-SNAPSHOT, -INTERNAL-SNAPSHOT) has no milestone, so it is
 * plain text.
 */
export function versionCell(version, milestoneUrl) {
  if (!milestoneUrl || version.endsWith("-SNAPSHOT")) {
    return version;
  }
  return `[${version}](${milestoneUrl})`;
}

const TRAIN_STATUS = {
  "not-joined": "not joined yet",
  joined: "joined, not ready yet",
  ready: "ready",
};

/**
 * The line of the summary that links to the release train that was used: the text is the
 * link, followed by the state of the train (linked) and where the release is in it (the status of check-not-ready).
 * Nothing without a train.
 */
export function trainLine(train, trainUrl, status, state, stateUrl) {
  if (!train) {
    return [];
  }
  const name = `Release train ${train}`;
  let text = trainUrl ? `[${name}](${trainUrl})` : name;
  if (state) {
    text += ` is ${stateUrl ? `[${state}](${stateUrl})` : state}`;
  }
  const where = TRAIN_STATUS[status];
  return [where ? `${text}: ${where}` : text, ""];
}
