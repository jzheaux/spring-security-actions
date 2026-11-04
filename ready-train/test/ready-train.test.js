import { describe, expect, it } from "vitest";
import {
  dispatchReady,
  findRun,
  readyReleases,
  readyRunsUrl,
  waitForRun,
} from "../src/index.js";

const REPOSITORY = "spring-projects/spring-security-commercial";

/**
 * A fake of the parts of the API that the action uses. The runs that a dispatch makes appear
 * after `lag` lists, and complete after `polls` reads.
 */
function fakeOctokit({
  lag = 0,
  polls = 0,
  conclusion = "success",
  failure,
} = {}) {
  const calls = { dispatches: [], lists: 0, reads: 0 };
  let runs = [];
  let id = 100;
  const octokit = {
    calls,
    rest: {
      actions: {
        createWorkflowDispatch: async (request) => {
          if (failure) {
            throw failure;
          }
          calls.dispatches.push(request);
          id += 1;
          runs.push({
            id,
            branch: request.ref,
            created_at: new Date().toISOString(),
            html_url: `https://github.com/${REPOSITORY}/actions/runs/${id}`,
            reads: 0,
          });
        },
        listWorkflowRuns: async (request) => {
          calls.lists += 1;
          const visible = calls.lists > lag ? runs : [];
          return {
            data: {
              workflow_runs: visible.filter((r) => r.branch === request.branch),
            },
          };
        },
        getWorkflowRun: async ({ run_id: runId }) => {
          calls.reads += 1;
          const run = runs.find((r) => r.id === runId);
          run.reads += 1;
          return {
            data:
              run.reads > polls
                ? { status: "completed", conclusion }
                : { status: "in_progress", conclusion: null },
          };
        },
      },
    },
  };
  return octokit;
}

const deps = (octokit) => ({ octokit, sleep: async () => {}, pollMs: 1 });

describe("dispatchReady", () => {
  it("runs release-train-ready.yml on the release branch with the release train", async () => {
    const octokit = fakeOctokit();
    await dispatchReady(
      {
        repository: REPOSITORY,
        releaseBranch: "release/7.0.5",
        train: "2026.11.19",
        trainRepository: "spring-io/release-train",
      },
      { octokit },
    );
    expect(octokit.calls.dispatches).toEqual([
      {
        owner: "spring-projects",
        repo: "spring-security-commercial",
        workflow_id: "release-train-ready.yml",
        ref: "release/7.0.5",
        inputs: {
          "release-train": "2026.11.19",
          "release-train-repository": "spring-io/release-train",
        },
      },
    ]);
  });

  it.each([403, 404])("explains a %s", async (status) => {
    const failure = Object.assign(new Error("nope"), { status });
    await expect(
      dispatchReady(
        {
          repository: REPOSITORY,
          releaseBranch: "release/7.0.5",
          train: "2026.11.19",
          trainRepository: "spring-io/release-train",
        },
        { octokit: fakeOctokit({ failure }) },
      ),
    ).rejects.toThrow(/the workflow must be on that branch/);
  });
});

describe("findRun", () => {
  it("finds a run that appears after a few tries", async () => {
    const octokit = fakeOctokit({ lag: 2 });
    const { dispatchedAt } = await dispatchReady(
      {
        repository: REPOSITORY,
        releaseBranch: "release/7.0.5",
        train: "t",
        trainRepository: "r/r",
      },
      { octokit },
    );
    const run = await findRun(
      { repository: REPOSITORY, releaseBranch: "release/7.0.5", dispatchedAt },
      deps(octokit),
    );
    expect(run.html_url).toMatch(/runs\/101$/);
    expect(octokit.calls.lists).toBe(3);
  });

  it("does not take a run from before the dispatch", async () => {
    const octokit = fakeOctokit();
    await dispatchReady(
      {
        repository: REPOSITORY,
        releaseBranch: "release/7.0.5",
        train: "t",
        trainRepository: "r/r",
      },
      { octokit },
    );
    const run = await findRun(
      {
        repository: REPOSITORY,
        releaseBranch: "release/7.0.5",
        dispatchedAt: Date.now() + 3_600_000,
      },
      { ...deps(octokit), findTimeoutMs: 3 },
    );
    expect(run).toBeUndefined();
  });
});

describe("waitForRun", () => {
  it("waits for the run to complete, and gives its conclusion", async () => {
    const octokit = fakeOctokit({ polls: 3, conclusion: "failure" });
    await dispatchReady(
      {
        repository: REPOSITORY,
        releaseBranch: "release/7.0.5",
        train: "t",
        trainRepository: "r/r",
      },
      { octokit },
    );
    const conclusion = await waitForRun(
      { repository: REPOSITORY, run: { id: 101 } },
      deps(octokit),
    );
    expect(conclusion).toBe("failure");
    expect(octokit.calls.reads).toBe(4);
  });

  it("gives up after the timeout", async () => {
    const octokit = fakeOctokit({ polls: 1000 });
    await dispatchReady(
      {
        repository: REPOSITORY,
        releaseBranch: "release/7.0.5",
        train: "t",
        trainRepository: "r/r",
      },
      { octokit },
    );
    expect(
      await waitForRun(
        { repository: REPOSITORY, run: { id: 101 } },
        { ...deps(octokit), timeoutMs: 5 },
      ),
    ).toBe("timed_out");
  });
});

describe("readyReleases", () => {
  const releases = [
    { version: "7.0.5", branch: "release/7.0.5" },
    { version: "7.0.5.1", branch: "release/7.0.5.1" },
  ];

  it("runs it once for each release and waits for every run", async () => {
    const octokit = fakeOctokit({ polls: 1 });
    const results = await readyReleases(
      {
        repository: REPOSITORY,
        releases,
        train: "2026.11.19",
        trainRepository: "spring-io/release-train",
        serverUrl: "https://github.com",
      },
      deps(octokit),
    );
    expect(octokit.calls.dispatches.map((d) => d.ref)).toEqual([
      "release/7.0.5",
      "release/7.0.5.1",
    ]);
    expect(results).toEqual([
      {
        branch: "release/7.0.5",
        version: "7.0.5",
        runUrl: expect.stringMatching(/runs\/101$/),
        conclusion: "success",
      },
      {
        branch: "release/7.0.5.1",
        version: "7.0.5.1",
        runUrl: expect.stringMatching(/runs\/102$/),
        conclusion: "success",
      },
    ]);
  });

  it("does not run it for a release that is ready already, and keeps the order of the plan", async () => {
    const octokit = fakeOctokit();
    const results = await readyReleases(
      {
        repository: REPOSITORY,
        releases: [{ ...releases[0], alreadyReady: true }, releases[1]],
        train: "2026.11.19",
        trainRepository: "spring-io/release-train",
        serverUrl: "https://github.com",
      },
      deps(octokit),
    );
    expect(octokit.calls.dispatches.map((d) => d.ref)).toEqual([
      "release/7.0.5.1",
    ]);
    expect(results.map((r) => [r.branch, r.conclusion])).toEqual([
      ["release/7.0.5", "already-ready"],
      ["release/7.0.5.1", "success"],
    ]);
    expect(results[0].runUrl).toBe("");
  });

  it("gives the link of the runs of the branch for a run that cannot be found", async () => {
    const octokit = fakeOctokit({ lag: 1_000_000 });
    const results = await readyReleases(
      {
        repository: REPOSITORY,
        releases: [releases[0]],
        train: "2026.11.19",
        trainRepository: "spring-io/release-train",
        serverUrl: "https://github.com",
      },
      { ...deps(octokit), findTimeoutMs: 2 },
    );
    expect(results).toEqual([
      {
        branch: "release/7.0.5",
        version: "7.0.5",
        runUrl: `https://github.com/${REPOSITORY}/actions/workflows/release-train-ready.yml?query=branch%3Arelease%2F7.0.5`,
        conclusion: "not-found",
      },
    ]);
  });

  it("reports a run that failed", async () => {
    const octokit = fakeOctokit({ conclusion: "failure" });
    const results = await readyReleases(
      {
        repository: REPOSITORY,
        releases: [releases[0]],
        train: "t",
        trainRepository: "r/r",
        serverUrl: "https://github.com",
      },
      deps(octokit),
    );
    expect(results[0].conclusion).toBe("failure");
  });
});

describe("readyRunsUrl", () => {
  it("is the runs of the workflow on the branch", () => {
    expect(
      readyRunsUrl({
        serverUrl: "https://github.com/",
        repository: REPOSITORY,
        branch: "release/7.0.5",
      }),
    ).toBe(
      "https://github.com/spring-projects/spring-security-commercial/actions/workflows/release-train-ready.yml?query=branch%3Arelease%2F7.0.5",
    );
  });
});
