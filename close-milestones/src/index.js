import fs from "node:fs";
import path from "node:path";
import * as core from "@actions/core";
import { call, createOctokit, parseRepository } from "./octokit.js";
import { execute, isMain, TitledError } from "./run.js";

export const DEFAULT_PLAN_FILE = "code-freeze/plan.json";
export const DEFAULT_MILESTONES_FILE = "code-freeze/milestones.json";

/**
 * Closes the milestone of one release, or deletes it. The milestone is read again, as issues
 * may have been moved in or out since the plan, and the counts of that read decide:
 *
 * - a hotfix with no issues at all, open or closed, is deleted: it has nothing to say,
 * - any other milestone is closed, with open issues too (the result says how many),
 *   and one that is closed already is left alone.
 */
export async function closeMilestone({ release }, { octokit }) {
  const { milestone } = release;
  const { owner, repo } = parseRepository(milestone.repository);
  const { data } = await call(
    `Reading the milestone ${milestone.title} of ${milestone.repository}`,
    octokit.rest.issues.getMilestone({
      owner,
      repo,
      milestone_number: milestone.number,
    }),
  );
  const base = {
    version: release.version,
    repository: milestone.repository,
    number: milestone.number,
    url: data.html_url ?? milestone.url,
    open: data.open_issues,
    closed: data.closed_issues,
  };
  if (release.hotfix && data.open_issues + data.closed_issues === 0) {
    await call(
      `Deleting the milestone ${milestone.title} of ${milestone.repository}`,
      octokit.rest.issues.deleteMilestone({
        owner,
        repo,
        milestone_number: milestone.number,
      }),
    );
    return { ...base, result: "deleted" };
  }
  if (data.state === "closed") {
    return { ...base, result: "already-closed" };
  }
  await call(
    `Closing the milestone ${milestone.title} of ${milestone.repository}`,
    octokit.rest.issues.updateMilestone({
      owner,
      repo,
      milestone_number: milestone.number,
      state: "closed",
    }),
  );
  return {
    ...base,
    result: data.open_issues > 0 ? "closed-with-open" : "closed",
  };
}

/**
 * Closes the milestones of the releases of a plan, each once. It goes on after one that
 * fails, and says which failed: a milestone left open can be closed by hand. Returns what
 * was done for each, in the order of the plan.
 */
export async function closeMilestones({ releases }, { octokit }) {
  const results = [];
  for (const release of releases.filter((r) => r.milestone)) {
    try {
      results.push(await closeMilestone({ release }, { octokit }));
    } catch (error) {
      results.push({
        version: release.version,
        repository: release.milestone.repository,
        number: release.milestone.number,
        url: release.milestone.url,
        result: "failed",
        error: error.message,
      });
    }
  }
  return results;
}

export async function main() {
  const base = process.env.RUNNER_TEMP ?? process.cwd();
  const planFile =
    core.getInput("plan-file") || path.join(base, DEFAULT_PLAN_FILE);
  const milestonesFile =
    core.getInput("milestones-file") ||
    path.join(base, DEFAULT_MILESTONES_FILE);
  const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
  const octokit = createOctokit({ token: core.getInput("token") });
  const results = await closeMilestones(
    { releases: plan.releases },
    { octokit },
  );
  fs.mkdirSync(path.dirname(milestonesFile), { recursive: true });
  fs.writeFileSync(milestonesFile, `${JSON.stringify(results, null, 2)}\n`);
  core.setOutput("milestones-file", milestonesFile);
  for (const r of results) {
    core.info(`${r.repository} ${r.version}: ${r.error ?? r.result}`);
  }
  const failed = results.filter((r) => r.result === "failed");
  if (failed.length > 0) {
    throw new TitledError(
      "Milestones not closed",
      `The freeze is done, and ${failed.length === 1 ? "this milestone was" : "these milestones were"} not closed: close ${failed.length === 1 ? "it" : "them"} by hand.\n- ${failed.map((r) => `${r.repository} ${r.version}: ${r.error}`).join("\n- ")}`,
    );
  }
}

if (isMain(import.meta.url)) {
  execute(main);
}
