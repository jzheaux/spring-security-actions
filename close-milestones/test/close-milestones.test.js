import { describe, expect, it } from "vitest";
import { closeMilestone, closeMilestones } from "../src/index.js";

const oss = "spring-projects/spring-security";
const commercial = "spring-projects/spring-security-commercial";

/** The milestones that GitHub has, by repository and number. */
function fakeOctokit(milestones, { failOn } = {}) {
  const closed = [];
  const deleted = [];
  const find = ({ owner, repo, milestone_number }) => {
    const found = milestones[`${owner}/${repo}`]?.[milestone_number];
    if (!found) {
      throw Object.assign(new Error("Not Found"), { status: 404 });
    }
    return found;
  };
  return {
    closed,
    deleted,
    rest: {
      issues: {
        getMilestone: async (request) => ({ data: find(request) }),
        updateMilestone: async (request) => {
          if (failOn === request.milestone_number) {
            throw Object.assign(new Error("Forbidden"), { status: 403 });
          }
          closed.push(request);
        },
        deleteMilestone: async (request) => {
          deleted.push(request);
        },
      },
    },
  };
}

const state = (open_issues, closed_issues, state = "open") => ({
  state,
  open_issues,
  closed_issues,
  html_url: "https://github.com/x/y/milestone/1",
});

const release = (version, repository, number, hotfix = false) => ({
  version,
  hotfix,
  milestone: {
    repository,
    title: version,
    number,
    url: `https://github.com/${repository}/milestone/${number}`,
  },
});

describe("closeMilestone", () => {
  it("closes a milestone with no open issues", async () => {
    const octokit = fakeOctokit({ [oss]: { 1: state(0, 41) } });
    expect(
      await closeMilestone({ release: release("7.0.5", oss, 1) }, { octokit }),
    ).toMatchObject({ result: "closed", open: 0, closed: 41 });
    expect(octokit.closed).toEqual([
      {
        owner: "spring-projects",
        repo: "spring-security",
        milestone_number: 1,
        state: "closed",
      },
    ]);
  });

  it("closes a milestone that has open issues, and says how many", async () => {
    const octokit = fakeOctokit({ [oss]: { 1: state(2, 17) } });
    expect(
      await closeMilestone(
        { release: release("7.1.0-RC1", oss, 1) },
        { octokit },
      ),
    ).toMatchObject({ result: "closed-with-open", open: 2, closed: 17 });
    expect(octokit.closed).toHaveLength(1);
  });

  it("leaves a milestone that is closed already", async () => {
    const octokit = fakeOctokit({
      [commercial]: { 1: state(0, 6, "closed") },
    });
    expect(
      await closeMilestone(
        { release: release("6.5.11", commercial, 1) },
        { octokit },
      ),
    ).toMatchObject({ result: "already-closed" });
    expect(octokit.closed).toEqual([]);
  });

  it("does not delete a milestone with no issues if it is not of a hotfix", async () => {
    const octokit = fakeOctokit({ [oss]: { 1: state(0, 0) } });
    expect(
      await closeMilestone({ release: release("7.0.5", oss, 1) }, { octokit }),
    ).toMatchObject({ result: "closed" });
    expect(octokit.deleted).toEqual([]);
  });

  it("deletes the milestone of a hotfix that has no issues at all", async () => {
    const octokit = fakeOctokit({ [commercial]: { 3: state(0, 0) } });
    expect(
      await closeMilestone(
        { release: release("7.0.5.1", commercial, 3, true) },
        { octokit },
      ),
    ).toMatchObject({ result: "deleted", open: 0, closed: 0 });
    expect(octokit.deleted).toEqual([
      {
        owner: "spring-projects",
        repo: "spring-security-commercial",
        milestone_number: 3,
      },
    ]);
    expect(octokit.closed).toEqual([]);
  });

  it("deletes the empty milestone of a hotfix that is closed, too", async () => {
    const octokit = fakeOctokit({
      [commercial]: { 3: state(0, 0, "closed") },
    });
    expect(
      await closeMilestone(
        { release: release("7.0.5.1", commercial, 3, true) },
        { octokit },
      ),
    ).toMatchObject({ result: "deleted" });
  });

  it.each([
    ["a closed issue", state(0, 1), "closed"],
    ["an open issue", state(1, 0), "closed-with-open"],
  ])(
    "closes the milestone of a hotfix that has %s",
    async (_, issues, result) => {
      const octokit = fakeOctokit({ [commercial]: { 3: issues } });
      expect(
        await closeMilestone(
          { release: release("7.0.5.1", commercial, 3, true) },
          { octokit },
        ),
      ).toMatchObject({ result });
      expect(octokit.deleted).toEqual([]);
    },
  );

  it("decides on the issues it reads now, and not on the ones of the plan", async () => {
    // the plan saw none, and an issue was moved in since
    const octokit = fakeOctokit({ [commercial]: { 3: state(0, 1) } });
    const entry = release("7.0.5.1", commercial, 3, true);
    Object.assign(entry.milestone, { open: 0, closed: 0 });
    expect(await closeMilestone({ release: entry }, { octokit })).toMatchObject(
      { result: "closed" },
    );
    expect(octokit.deleted).toEqual([]);
  });
});

describe("closeMilestones", () => {
  it("does each release that has a milestone, in the order of the plan", async () => {
    const octokit = fakeOctokit({
      [oss]: { 1: state(0, 4) },
      [commercial]: { 2: state(0, 0), 3: state(0, 2) },
    });
    const results = await closeMilestones(
      {
        releases: [
          release("7.0.5", oss, 1),
          release("7.0.5.1", commercial, 2, true),
          { version: "7.1.1", hotfix: false },
          release("6.5.11", commercial, 3),
        ],
      },
      { octokit },
    );
    expect(results.map((r) => [r.version, r.result])).toEqual([
      ["7.0.5", "closed"],
      ["7.0.5.1", "deleted"],
      ["6.5.11", "closed"],
    ]);
  });

  it("goes on after a milestone that fails, and says which", async () => {
    const octokit = fakeOctokit(
      { [oss]: { 1: state(0, 4), 2: state(0, 1) } },
      { failOn: 1 },
    );
    const results = await closeMilestones(
      { releases: [release("7.0.5", oss, 1), release("7.1.1", oss, 2)] },
      { octokit },
    );
    expect(results[0]).toMatchObject({ version: "7.0.5", result: "failed" });
    expect(results[0].error).toMatch(/Closing the milestone 7\.0\.5 .* 403/);
    expect(results[1]).toMatchObject({ version: "7.1.1", result: "closed" });
  });
});
