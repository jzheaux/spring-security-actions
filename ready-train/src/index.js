import fs from "node:fs";
import path from "node:path";
import * as core from "@actions/core";
import { createOctokit, parseRepository } from "./octokit.js";
import { execute, isMain } from "./run.js";

export const READY_WORKFLOW = "release-train-ready.yml";
export const DEFAULT_PLAN_FILE = "code-freeze/plan.json";
export const DEFAULT_READY_FILE = "code-freeze/ready.json";

// The clock of GitHub and the one of the runner are not the same one: a run made a few
// seconds before the dispatch, by the clock of the runner, is the one that it made.
const CLOCK_SKEW_MS = 15_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The page of the runs of the workflow on a branch, which is what a run that is not found links to. */
export function readyRunsUrl({ serverUrl, repository, branch }) {
  return `${serverUrl.replace(/\/$/, "")}/${repository}/actions/workflows/${READY_WORKFLOW}?query=branch%3A${encodeURIComponent(branch)}`;
}

/**
 * Runs release-train-ready.yml of the project on a release branch, with the release train
 * (the workflow runs `ready` in the release train repository for the commit of the branch, and
 * waits for it). Dispatching a workflow does not say which run it made, so the run is the
 * newest one of that workflow on that branch that was made since: it returns the dispatch time
 * for finding it.
 */
export async function dispatchReady(
  { repository, releaseBranch, train, trainRepository },
  { octokit, now = () => Date.now() },
) {
  const { owner, repo } = parseRepository(repository);
  const dispatchedAt = now();
  try {
    await octokit.rest.actions.createWorkflowDispatch({
      owner,
      repo,
      workflow_id: READY_WORKFLOW,
      ref: releaseBranch,
      inputs: {
        "release-train": train,
        "release-train-repository": trainRepository,
      },
    });
  } catch (error) {
    if (error.status === 403 || error.status === 404) {
      throw new Error(
        `Could not run ${READY_WORKFLOW} on ${releaseBranch} in ${repository}: the workflow must be on that branch, and the token needs Actions: Read and write on the repository (a fine-grained token) or the scope repo (a classic one) (${error.status} ${error.message})`,
      );
    }
    throw error;
  }
  return { dispatchedAt };
}

/** Finds the run that a dispatch made: the newest one on the branch since the dispatch. */
export async function findRun(
  { repository, releaseBranch, dispatchedAt },
  { octokit, sleep: wait = sleep, pollMs = 3000, findTimeoutMs = 90_000 },
) {
  const { owner, repo } = parseRepository(repository);
  for (let waited = 0; ; waited += pollMs) {
    const { data } = await octokit.rest.actions.listWorkflowRuns({
      owner,
      repo,
      workflow_id: READY_WORKFLOW,
      branch: releaseBranch,
      event: "workflow_dispatch",
      per_page: 20,
    });
    const runs = (data.workflow_runs ?? [])
      .filter((r) => Date.parse(r.created_at) >= dispatchedAt - CLOCK_SKEW_MS)
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    if (runs.length > 0) {
      return runs[0];
    }
    if (waited >= findTimeoutMs) {
      return undefined;
    }
    await wait(pollMs);
  }
}

/** Waits for a run to complete, and returns its conclusion (success, failure, cancelled...). */
export async function waitForRun(
  { repository, run },
  { octokit, sleep: wait = sleep, pollMs = 3000, timeoutMs = 30 * 60_000 },
) {
  const { owner, repo } = parseRepository(repository);
  for (let waited = 0; ; waited += pollMs) {
    const { data } = await octokit.rest.actions.getWorkflowRun({
      owner,
      repo,
      run_id: run.id,
    });
    if (data.status === "completed") {
      return data.conclusion;
    }
    if (waited >= timeoutMs) {
      return "timed_out";
    }
    await wait(pollMs);
  }
}

/**
 * Marks every release of the plan ready: release-train-ready.yml runs on each release branch,
 * once each, all at the same time, and then it waits for all of them. It returns, for each,
 * { branch, version, runUrl, conclusion }: the conclusion is success if it worked, and is
 * "not-found" for a run that could not be found, which cannot be waited for. A release
 * that is ready already (`alreadyReady` in the plan) is not run again: its conclusion is
 * "already-ready", with no run. The caller fails if any is neither that nor a success.
 */
export async function readyReleases(
  { repository, releases, train, trainRepository, serverUrl },
  deps,
) {
  const dispatched = [];
  const skipped = releases
    .filter((release) => release.alreadyReady)
    .map((release) => ({
      branch: release.branch,
      version: release.version,
      runUrl: "",
      conclusion: "already-ready",
    }));
  for (const release of releases.filter((r) => !r.alreadyReady)) {
    const { dispatchedAt } = await dispatchReady(
      { repository, releaseBranch: release.branch, train, trainRepository },
      deps,
    );
    dispatched.push({ release, dispatchedAt });
  }
  const results = await Promise.all(
    dispatched.map(async ({ release, dispatchedAt }) => {
      const base = { branch: release.branch, version: release.version };
      const run = await findRun(
        { repository, releaseBranch: release.branch, dispatchedAt },
        deps,
      );
      if (!run) {
        return {
          ...base,
          runUrl: readyRunsUrl({
            serverUrl,
            repository,
            branch: release.branch,
          }),
          conclusion: "not-found",
        };
      }
      const conclusion = await waitForRun({ repository, run }, deps);
      return { ...base, runUrl: run.html_url, conclusion };
    }),
  );
  // in the order of the plan
  return releases.map(
    (release) =>
      skipped.find((r) => r.branch === release.branch) ??
      results.find((r) => r.branch === release.branch),
  );
}

export async function main() {
  const planFile =
    core.getInput("plan-file") ||
    path.join(process.env.RUNNER_TEMP ?? process.cwd(), DEFAULT_PLAN_FILE);
  const readyFile =
    core.getInput("ready-file") ||
    path.join(process.env.RUNNER_TEMP ?? process.cwd(), DEFAULT_READY_FILE);
  const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
  const repository =
    core.getInput("repository") || process.env.GITHUB_REPOSITORY || "";
  const serverUrl = process.env.GITHUB_SERVER_URL || "https://github.com";
  const octokit = createOctokit({ token: core.getInput("token") });
  const pollMs = Number(core.getInput("poll-interval") || 3) * 1000;
  const results = await readyReleases(
    {
      repository,
      releases: plan.releases,
      train: plan.train,
      trainRepository:
        core.getInput("release-train-repository") || "spring-io/release-train",
      serverUrl,
    },
    { octokit, pollMs },
  );
  fs.mkdirSync(path.dirname(readyFile), { recursive: true });
  fs.writeFileSync(readyFile, `${JSON.stringify(results, null, 2)}\n`);
  core.setOutput("ready-file", readyFile);
  for (const r of results) {
    core.info(
      r.conclusion === "already-ready"
        ? `${r.branch}: ready already, nothing to do`
        : `${r.branch}: ${r.conclusion} (${r.runUrl})`,
    );
  }
  const failed = results.filter(
    (r) => !["success", "already-ready"].includes(r.conclusion),
  );
  if (failed.length > 0) {
    throw new Error(
      `${failed.map((r) => `${r.branch} (${r.conclusion === "not-found" ? "the run could not be found, so it was not waited for" : r.conclusion}: ${r.runUrl})`).join(", ")} did not succeed in ${READY_WORKFLOW}: the release is not ready, so nothing was pushed`,
    );
  }
}

if (isMain(import.meta.url)) {
  execute(main);
}
