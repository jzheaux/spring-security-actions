import { describe, expect, it } from "vitest";
import { run } from "../src/index.js";

const repository = "spring-projects/spring-security-commercial";

function fakeOctokit(milestones) {
  const created = [];
  return {
    created,
    paginate: async () => milestones,
    rest: {
      issues: {
        listMilestones: () => {},
        createMilestone: async (request) => {
          created.push(request);
          return {
            data: { html_url: `https://github.com/${repository}/milestone/99` },
          };
        },
      },
    },
  };
}

describe("ensure-milestone", () => {
  it("creates a milestone that does not exist, with a title and nothing else", async () => {
    const octokit = fakeOctokit([{ title: "7.0.0", state: "closed" }]);
    expect(await run({ repository, milestone: "7.0.1" }, { octokit })).toEqual({
      created: true,
      url: `https://github.com/${repository}/milestone/99`,
    });
    expect(octokit.created).toEqual([
      {
        owner: "spring-projects",
        repo: "spring-security-commercial",
        title: "7.0.1",
      },
    ]);
  });

  it.each(["open", "closed"])(
    "does not touch a milestone that is %s",
    async (state) => {
      const octokit = fakeOctokit([
        {
          title: "7.0.1",
          state,
          html_url: "https://github.com/x/y/milestone/3",
        },
      ]);
      expect(
        await run({ repository, milestone: "7.0.1" }, { octokit }),
      ).toEqual({ created: false, url: "https://github.com/x/y/milestone/3" });
      expect(octokit.created).toEqual([]);
    },
  );

  it("does not take a milestone of another title for it", async () => {
    const octokit = fakeOctokit([{ title: "7.0.1.1", state: "open" }]);
    const result = await run({ repository, milestone: "7.0.1" }, { octokit });
    expect(result.created).toBe(true);
  });

  it("rejects a repository that is not owner/repo", async () => {
    await expect(
      run(
        { repository: "nope", milestone: "7.0.1" },
        { octokit: fakeOctokit([]) },
      ),
    ).rejects.toThrow(/is not a repository/);
  });
});
