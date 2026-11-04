import { describe, expect, it } from "vitest";
import { run } from "../src/index.js";

const repository = "spring-projects/spring-security-commercial";

function fakeOctokit(milestones) {
  const created = [];
  const updates = [];
  return {
    created,
    updates,
    paginate: async () => milestones,
    rest: {
      issues: {
        listMilestones: () => {},
        updateMilestone: async (request) => {
          updates.push(request);
        },
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
      changed: false,
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
      ).toEqual({
        created: false,
        changed: false,
        url: "https://github.com/x/y/milestone/3",
      });
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

  describe("with a due date", () => {
    const dueDate = "2026-11-19";
    it("creates the milestone with it, at noon UTC", async () => {
      const octokit = fakeOctokit([]);
      const result = await run(
        { repository, milestone: "7.0.1", dueDate },
        { octokit },
      );
      expect(result.created).toBe(true);
      expect(octokit.created[0]).toMatchObject({
        title: "7.0.1",
        due_on: "2026-11-19T12:00:00Z",
      });
    });

    it.each([null, "2026-11-12T12:00:00Z"])(
      "changes a milestone that is due %s",
      async (due_on) => {
        const octokit = fakeOctokit([
          { number: 4, title: "7.0.1", state: "open", due_on },
        ]);
        const result = await run(
          { repository, milestone: "7.0.1", dueDate },
          { octokit },
        );
        expect(result).toMatchObject({ created: false, changed: true });
        expect(octokit.updates).toEqual([
          {
            owner: "spring-projects",
            repo: "spring-security-commercial",
            milestone_number: 4,
            due_on: "2026-11-19T12:00:00Z",
          },
        ]);
        expect(octokit.created).toEqual([]);
      },
    );

    it("changes nothing if it is due that day already", async () => {
      const octokit = fakeOctokit([
        {
          number: 4,
          title: "7.0.1",
          state: "closed",
          due_on: "2026-11-19T12:00:00Z",
        },
      ]);
      const result = await run(
        { repository, milestone: "7.0.1", dueDate },
        { octokit },
      );
      expect(result).toMatchObject({ created: false, changed: false });
      expect(octokit.updates).toEqual([]);
    });

    it("does not change the due date of a milestone without one given", async () => {
      const octokit = fakeOctokit([
        { number: 4, title: "7.0.1", state: "open", due_on: null },
      ]);
      await run({ repository, milestone: "7.0.1" }, { octokit });
      expect(octokit.updates).toEqual([]);
    });

    it("rejects what is not a date", async () => {
      await expect(
        run(
          { repository, milestone: "7.0.1", dueDate: "tomorrow" },
          { octokit: fakeOctokit([]) },
        ),
      ).rejects.toThrow(/is not a date/);
    });
  });
});
