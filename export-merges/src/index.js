import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as core from "@actions/core";
import { git } from "./git.js";
import { execute, isMain } from "./run.js";
import { addSummary, table } from "./summary.js";

export const DEFAULT_PLAN_FILE = "post-publish/plan.json";
export const DEFAULT_MERGE_FILE = "post-publish/merge.json";

const short = (commit) => commit.slice(0, 7);

/** The rows of the table of the branches, for the summary and for the README. */
function rowsOf(plan, merge) {
  const repositories = {
    oss: plan.ossRepository,
    commercial: plan.commercialRepository,
  };
  return merge.branches.map((b) => [
    repositories[b.repository] ?? b.repository,
    `\`${b.branch}\``,
    short(b.after),
    b.changed ? short(b.before) : "up to date",
  ]);
}

const HEADER = ["Repository", "Branch", "Commit", "Before"];

/** The commands to look at the merges, with the first changed branch as the example. */
function inspectCommands(merge) {
  const example = merge.branches.find((b) => b.changed) ?? merge.branches[0];
  return [
    `git log --graph --oneline ${example.branch}`,
    ...(example.changed
      ? [`git diff ${short(example.before)} ${example.branch}`]
      : []),
  ];
}

function refLine(merge) {
  return merge.ref
    ? `The ref \`${merge.ref.name}\` (${short(merge.ref.sha)}) stands in for the tag \`${merge.tag}\`, which does not exist yet.`
    : undefined;
}

/**
 * Exports the branches that merge-tag made: a new git repository in `target`, with only those
 * branches (each named as it is in its repository), fetched from the work refs of the clone.
 * It is for looking at the merges: it has no remote and no command that pushes. It returns
 * { branches: [{ repository, branch, commit, before, changed }] }, and the directory has a
 * README.md with the table of the branches and how to look at them.
 */
export function exportMerges({ directory, merge, plan, target, dryRun }) {
  if (fs.existsSync(target) && fs.readdirSync(target).length > 0) {
    throw new Error(`The directory ${target} exists, and is not empty`);
  }
  const twice = merge.branches.find(
    (b, i) => merge.branches.findIndex((o) => o.branch === b.branch) !== i,
  );
  if (twice) {
    throw new Error(
      `The branch ${twice.branch} is in the merges of two repositories, and they cannot both be a branch of one export`,
    );
  }
  if (merge.branches.length === 0) {
    return { branches: [] };
  }
  const clone = path.resolve(directory);
  fs.mkdirSync(target, { recursive: true });
  git(target, "init", "-q");
  git(
    target,
    "fetch",
    "--quiet",
    "--no-tags",
    clone,
    ...merge.branches.map((b) => `${b.ref}:refs/heads/${b.branch}`),
  );
  git(target, "symbolic-ref", "HEAD", `refs/heads/${merge.branches[0].branch}`);
  const branches = merge.branches.map((b) => ({
    repository: b.repository,
    branch: b.branch,
    commit: git(target, "rev-parse", `refs/heads/${b.branch}`),
    before: b.before,
    changed: b.changed,
  }));
  fs.writeFileSync(
    path.join(target, "README.md"),
    [
      `# Merged branches of ${merge.tag}${dryRun ? " (dry run)" : ""}`,
      "",
      `These branches are what the merges of the tag ${merge.tag} made in the clone of the runner.${dryRun ? " Nothing was pushed." : ""} Each is named as it is in its repository.`,
      ...(refLine(merge) ? ["", refLine(merge)] : []),
      "",
      table(HEADER, rowsOf(plan, merge)),
      "",
      "To look at them, from inside this directory, for example:",
      "",
      "```",
      ...inspectCommands(merge),
      "```",
      "",
    ].join("\n"),
  );
  return { branches };
}

export async function main() {
  const tmp = process.env.RUNNER_TEMP || os.tmpdir();
  const planFile =
    core.getInput("plan-file") || path.join(tmp, DEFAULT_PLAN_FILE);
  const mergeFile =
    core.getInput("merge-file") || path.join(tmp, DEFAULT_MERGE_FILE);
  const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
  const merge = JSON.parse(fs.readFileSync(mergeFile, "utf8"));
  const name = core.getInput("name") || `merged-branches-${merge.tag}`;
  const target = core.getInput("directory") || path.join(tmp, name);
  const dryRun = core.getInput("dry-run").trim().toLowerCase() === "true";
  const { branches } = exportMerges({
    directory: core.getInput("path") || ".",
    merge,
    plan,
    target,
    dryRun,
  });
  const lines = [
    `### Merged branches of ${merge.tag}${dryRun ? " (dry run)" : ""}`,
    "",
  ];
  if (branches.length > 0) {
    lines.push(
      ...(refLine(merge) ? [refLine(merge), ""] : []),
      table(HEADER, rowsOf(plan, merge)),
      "",
      `Download the artifact \`${name}\`, unzip it, and from inside it, for example:`,
      "",
      "```",
      ...inspectCommands(merge),
      "```",
    );
  } else {
    lines.push("There is nothing to export: no branch was merged.");
  }
  addSummary(lines.join("\n"));
  core.setOutput("directory", target);
  core.setOutput("name", name);
  core.setOutput("count", String(branches.length));
  for (const b of branches) {
    core.info(`Exported ${b.branch} (${short(b.commit)}) in ${target}`);
  }
}

if (isMain(import.meta.url)) {
  execute(main);
}
