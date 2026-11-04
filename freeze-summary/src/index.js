import fs from "node:fs";
import path from "node:path";
import * as core from "@actions/core";
import { execute, isMain } from "./run.js";
import { addSummary, table } from "./summary.js";

const read = (file) => {
  if (!file || !fs.existsSync(file)) {
    return undefined;
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
};

const short = (sha) => (sha ? sha.slice(0, 7) : "");

/** The version commit of a branch that was made, as a short commit, if the run made it. */
const commitOf = (apply, branch) => {
  const bump = apply?.bumps?.find((b) => b.branch === branch);
  return bump ? ` (${short(bump.commit)})` : "";
};

/** The Versions table: every branch with the version it has and the one it is bumped to. */
export function versionsTable(plan, apply) {
  const rows = [];
  for (const g of plan.oss) {
    const commit = g.bump
      ? `Next Development Version (${g.next})${commitOf(apply, g.branch)}`
      : `none: the version stays, as ${g.current.replace(/-SNAPSHOT$/, "")} has no GA milestone yet`;
    rows.push([g.branch, "OSS", g.current, g.next, commit]);
    rows.push([
      g.frozen,
      "commercial",
      g.current,
      g.next,
      g.bump
        ? `arrives by the merge of ${g.branch} (no commit of its own)`
        : "none",
    ]);
    rows.push([
      g.active,
      "commercial",
      g.current,
      g.next,
      g.bump ? "arrives by the merge of frozen" : "none",
    ]);
  }
  for (const g of plan.lts) {
    rows.push([
      g.branch,
      "commercial",
      g.current,
      g.next,
      g.bump
        ? `Next Development Version (${g.next})${commitOf(apply, g.branch)}`
        : "none: the version stays",
    ]);
  }
  return table(
    ["Branch", "Repository", "Current version", "Bumped to", "Commit"],
    rows,
  );
}

const readyCell = ({ release, ready, dryRun }) => {
  if (release.alreadyReady) {
    return "Ready already, skipped";
  }
  if (dryRun) {
    return "Not run, this is a dry run";
  }
  const result = ready?.find((r) => r.branch === release.branch);
  if (!result) {
    return "Not run";
  }
  if (result.conclusion === "success") {
    return `[Succeeded](${result.runUrl})`;
  }
  if (result.conclusion === "not-found") {
    return `[The run could not be found](${result.runUrl})`;
  }
  return `[Failed: ${result.conclusion}](${result.runUrl})`;
};

/** The releases that are marked ready, each once, with the branches that it is the release of. */
export function readyTable(plan, ready, dryRun) {
  return table(
    ["Release branch", "Release of", "Ready"],
    plan.releases.map((release) => [
      release.branch,
      release.of.join(", ") +
        (release.version.split(".").length === 4 ? " (a hotfix)" : ""),
      readyCell({ release, ready, dryRun }),
    ]),
  );
}

/** The merges, in the order they were made, with which version stays. */
export function mergesTable(apply) {
  const rows = apply.merges.map((m) => [
    m.kind,
    `${m.message}${m.outcome === "up-to-date" ? " (already merged, nothing to do)" : ""}`,
    m.into ?? "",
    m.kind === "down" ? "source" : "target",
  ]);
  for (const r of apply.rotation) {
    rows.push(["rotation", `fast forward to ${r.active}`, r.branch, "same"]);
  }
  return table(["Kind", "Merge", "Into", "Version kept"], rows);
}

function pushSection(push, dryRun) {
  const verb = push.mode === "check" || dryRun ? "dry run" : "pushed";
  const lines = [
    `- commercial: git push --atomic (${verb}), ${push.commercial.branches.length} branches`,
    `- OSS: git push --atomic (${verb}), ${push.oss.branches.length} branches`,
  ];
  const { commits, problems } = push.leakCheck;
  lines.push(
    problems.length === 0
      ? `- OSS leak check: ${push.oss.branches.length} branches, ${commits} new commits, all made by this run, none of them in a commercial branch: OK`
      : `- OSS leak check: FAILED, nothing was pushed:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
  );
  return lines.join("\n");
}

/**
 * The summary of a code freeze, as markdown. Every part is optional, as the run may have
 * stopped before it: the plan came first, then what was applied, ready and pushed.
 */
export function render({ plan, apply, ready, push, dryRun, status }) {
  const parts = [];
  const flags = [dryRun ? "DRY RUN" : "", status === "failure" ? "FAILED" : ""]
    .filter(Boolean)
    .join("   ");
  parts.push(
    `# Code freeze: ${plan?.project ?? "project"}, release train ${plan?.train ?? "?"}${flags ? `     ${flags}` : ""}`,
  );
  if (!plan) {
    parts.push("The run stopped before it made a plan.");
    return parts.join("\n\n");
  }
  if (plan.problems?.length > 0) {
    parts.push(
      `The plan found ${plan.problems.length === 1 ? "a problem" : `${plan.problems.length} problems`}. Nothing was merged, dispatched or pushed.\n\n${plan.problems.map((p) => `- ${p}`).join("\n")}`,
    );
  }
  if (plan.oss.length + plan.lts.length > 0) {
    parts.push(
      `## Versions${plan.problems?.length > 0 ? " (what would have been done)" : ""}\n${versionsTable(plan, apply)}`,
    );
  }
  if (plan.problems?.length === 0 && plan.releases.length > 0) {
    parts.push(
      `## Releases marked ready in the release train ${plan.train}\nEach release branch is marked ready once, before any bump is pushed, by running release-train-ready.yml on that branch.\n\n${readyTable(plan, ready, dryRun)}`,
    );
  }
  if (apply) {
    parts.push(`## Merges (in order)\n${mergesTable(apply)}`);
  }
  if (push) {
    parts.push(`## Push\n${pushSection(push, dryRun)}`);
  }
  return parts.join("\n\n");
}

export async function main() {
  const base = process.env.RUNNER_TEMP ?? process.cwd();
  const file = (name, fallback) =>
    core.getInput(name) || path.join(base, "code-freeze", fallback);
  const markdown = render({
    plan: read(file("plan-file", "plan.json")),
    apply: read(file("apply-file", "apply.json")),
    ready: read(file("ready-file", "ready.json")),
    push: read(file("push-file", "push.json")),
    dryRun: core.getInput("dry-run") === "true",
    status: core.getInput("job-status"),
  });
  addSummary(markdown);
}

if (isMain(import.meta.url)) {
  execute(main);
}
