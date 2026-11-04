import * as core from "@actions/core";
import { git } from "./git.js";
import { execute, isMain } from "./run.js";
import { fetchOss } from "./oss.js";
import { collectReport, renderSection, setupCommands } from "./report.js";
import {
  addSummary,
  branchCell,
  commitLink,
  table,
  trainLine,
  versionCell,
} from "./summary.js";

/**
 * The branches to push from the lines of the input: branch=version, one per line, where the
 * version is what the summary says the branch has.
 */
export function parseBranches(text) {
  const branches = (text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const at = line.lastIndexOf("=");
      if (at <= 0 || at === line.length - 1) {
        throw new Error(`"${line}" is not branch=version`);
      }
      return { branch: line.slice(0, at), version: line.slice(at + 1) };
    });
  if (branches.length === 0) {
    throw new Error(
      "The input branches is required: branch=version, one per line",
    );
  }
  return branches;
}

/**
 * Pushes the branches at once, or none (git push --atomic), so that a failure never leaves
 * one of them built and the others not. It is forced, because the branches are built
 * again from the pushed commit every time. It returns, for every branch, how many commits
 * it has on the pushed commit.
 */
export function pushBranches({ directory, remote = "origin", branches, base }) {
  const counts = branches.map(({ branch }) =>
    Number(git(directory, "rev-list", "--count", `${base}..${branch}`)),
  );
  git(
    directory,
    "push",
    "--atomic",
    "--force",
    remote,
    ...branches.map((b) => b.branch),
  );
  return branches.map((b, i) => ({ ...b, commits: counts[i] }));
}

/** The sentence that says what the push creates: the branches that are used for releasing. */
export function introduction(sections, kind) {
  const cells = sections.map(({ branch }) => branchCell(branch));
  const release = sections.find(({ role }) => role === "release");
  const snapshot = sections.find(({ role }) => role === "snapshot");
  if (sections.length === 2 && release && snapshot) {
    const what = `${kind === "active" ? "the hotfix " : ""}${release.version}`;
    return `This push creates two branches that are used for releasing ${what}: ${branchCell(snapshot.branch)}, the snapshot, and ${branchCell(release.branch)}, the release. They are pushed together (one atomic push).`;
  }
  if (sections.length === 1) {
    return `This push creates the branch ${cells[0]}.`;
  }
  return `This push creates the branches ${cells.join(", ")}. They are pushed together (one atomic push).`;
}

/** The address that git fetches OSS from: the input oss-url, or the repository on the server. */
export function ossUrl() {
  const url = core.getInput("oss-url");
  if (url) {
    return url;
  }
  const repository = core.getInput("oss-repository");
  if (!repository) {
    return "";
  }
  const server = (
    process.env.GITHUB_SERVER_URL || "https://github.com"
  ).replace(/\/+$/, "");
  return `${server}/${repository}.git`;
}

export async function main() {
  const base = core.getInput("base") || process.env.GITHUB_SHA;
  if (!base) {
    throw new Error("The input base is required: the commit that was pushed");
  }
  const directory = core.getInput("path") || ".";
  const remote = core.getInput("remote") || "origin";
  const pushed = pushBranches({
    directory,
    remote,
    branches: parseBranches(core.getInput("branches")),
    base,
  });
  for (const { branch, version, commits } of pushed) {
    core.info(
      `Pushed ${branch} (${version}): ${commits} commits on ${base.slice(0, 7)}`,
    );
  }
  const ossBranch = core.getInput("oss-branch");
  const ossTag = core.getInput("oss-tag");
  const oss = {
    branch: ossBranch,
    tag: ossTag,
    ...fetchOss({
      directory,
      url: ossUrl(),
      branch: ossBranch,
      tag: ossTag,
    }),
  };
  if (oss.error) {
    core.warning(`OSS could not be read: ${oss.error}`, {
      title: "No OSS to compare with",
    });
  }
  const report = collectReport({
    directory,
    remote,
    pushed,
    base,
    refName: process.env.GITHUB_REF_NAME,
    kind: core.getInput("kind"),
    train: core.getInput("train"),
    oss,
    snapshotOf: core.getInput("snapshot-of"),
    releaseOf: core.getInput("release-of"),
    merged: {
      snapshot: core.getInput("merged-snapshot"),
      release: core.getInput("merged-release"),
    },
  });
  const setup = setupCommands(report);
  addSummary(
    [
      `### ${core.getInput("title") || process.env.GITHUB_REF_NAME || "Branches"}`,
      "",
      introduction(report.sections, report.kind),
      "",
      ...trainLine(
        core.getInput("train"),
        core.getInput("train-url"),
        core.getInput("train-status"),
        core.getInput("train-state"),
        core.getInput("train-state-url"),
      ),
      table(
        ["Branch", "Version", "Not in OSS"],
        report.sections.map(({ branch, version, commits }) => [
          branchCell(branch),
          versionCell(version, core.getInput("milestone-url")),
          commits.length,
        ]),
      ),
      "",
      `The pushed commit is ${commitLink(base)}. To run the commands below, in a clone of this repository${setup.usesOss ? ", add OSS once and fetch the branches" : ", fetch the branches"}:`,
      "",
      "```shell",
      ...setup.lines,
      "```",
      "",
      ...report.sections.flatMap((section) => [
        ...renderSection(section, { remote, cell: (b) => `\`${b}\`` }),
        "",
      ]),
    ].join("\n"),
  );
}

if (isMain(import.meta.url)) {
  execute(main);
}
