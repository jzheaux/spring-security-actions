import { describe, expect, it } from "vitest";
import { closeReason, copiedComment, run } from "../src/index.js";

const source = "spring-projects/spring-security-commercial";
const destination = "spring-projects/spring-security";

const issue = (number, extra = {}) => ({
  number,
  title: `Issue ${number}`,
  body: `Body of ${number}`,
  state: "open",
  state_reason: null,
  labels: [{ name: "type: bug" }],
  assignees: [],
  comments: 0,
  ...extra,
});

/**
 * A fake of GitHub: the milestones of both repositories, the issues of the milestone of the
 * source, their comments, and the users that cannot be assigned in the destination. It records
 * what is written.
 */
function fakeOctokit({
  items = [],
  comments = {},
  sourceMilestones = [{ title: "7.0.1", number: 3 }],
  destinationMilestones = [{ title: "7.0.1", number: 8 }],
  unassignable = [],
  dropAssignees = false,
} = {}) {
  const created = [];
  const posted = [];
  const updates = [];
  let next = 100;
  return {
    created,
    posted,
    updates,
    paginate: async (method, params) => method(params),
    rest: {
      issues: {
        listMilestones: ({ repo }) =>
          repo === "spring-security-commercial"
            ? sourceMilestones
            : destinationMilestones,
        listForRepo: () => items,
        listComments: ({ issue_number }) => comments[issue_number] ?? [],
        checkUserCanBeAssigned: async ({ assignee }) => {
          if (unassignable.includes(assignee)) {
            throw Object.assign(new Error("Not Found"), { status: 404 });
          }
        },
        create: async (request) => {
          created.push(request);
          next++;
          return {
            data: {
              number: next,
              html_url: `https://github.com/${destination}/issues/${next}`,
              assignees: dropAssignees
                ? []
                : request.assignees.map((login) => ({ login })),
            },
          };
        },
        createComment: async (request) => {
          posted.push(request);
        },
        update: async (request) => {
          updates.push(request);
        },
      },
    },
  };
}

const input = { source, destination, milestone: "7.0.1" };

describe("copy-milestone-issues", () => {
  it("copies an issue with its title, body, labels, assignees and the milestone of the destination, and nothing more", async () => {
    const octokit = fakeOctokit({
      items: [
        issue(586, {
          title: "Fix CVE-2026-41008",
          assignees: [{ login: "jgrandja" }],
          labels: [{ name: "type: bug" }, { name: "in: oauth2" }],
          type: { name: "Bug" },
        }),
      ],
    });
    const result = await run(input, { octokit });
    expect(octokit.created).toEqual([
      {
        owner: "spring-projects",
        repo: "spring-security",
        title: "Fix CVE-2026-41008",
        body: "Body of 586",
        labels: ["type: bug", "in: oauth2"],
        assignees: ["jgrandja"],
        milestone: 8,
        type: "Bug",
      },
    ]);
    expect(result.copied).toEqual([
      {
        from: `${source}#586`,
        to: `${destination}#101`,
        url: `https://github.com/${destination}/issues/101`,
      },
    ]);
    expect(result.skipped).toEqual([]);
  });

  it("says nothing of the source in the copy", async () => {
    const octokit = fakeOctokit({ items: [issue(586)] });
    await run(input, { octokit });
    expect(JSON.stringify(octokit.created)).not.toContain("commercial");
  });

  it("comments on the original with the link to the copy", async () => {
    const octokit = fakeOctokit({ items: [issue(586)] });
    await run(input, { octokit });
    expect(octokit.posted).toEqual([
      {
        owner: "spring-projects",
        repo: "spring-security-commercial",
        issue_number: 586,
        body: `Copied to ${destination}#101.\n\n<!-- copied-to: ${destination}#101 -->`,
      },
    ]);
    expect(octokit.posted[0].body).toBe(copiedComment(destination, 101));
  });

  it("copies without the body when omit-body is true, and keeps the rest", async () => {
    const octokit = fakeOctokit({ items: [issue(586)] });
    await run({ ...input, omitBody: true }, { octokit });
    expect(octokit.created[0]).not.toHaveProperty("body");
    expect(octokit.created[0].title).toBe("Issue 586");
    expect(octokit.created[0].labels).toEqual(["type: bug"]);
  });

  it("copies an issue without a body when it has none", async () => {
    const octokit = fakeOctokit({ items: [issue(586, { body: null })] });
    await run(input, { octokit });
    expect(octokit.created[0]).not.toHaveProperty("body");
  });

  it("closes the copy of a closed issue with the reason of the original", async () => {
    const octokit = fakeOctokit({
      items: [
        issue(1, { state: "closed", state_reason: "completed" }),
        issue(2, { state: "closed", state_reason: "not_planned" }),
        issue(3),
      ],
    });
    await run(input, { octokit });
    expect(octokit.updates).toEqual([
      {
        owner: "spring-projects",
        repo: "spring-security",
        issue_number: 101,
        state: "closed",
        state_reason: "completed",
      },
      {
        owner: "spring-projects",
        repo: "spring-security",
        issue_number: 102,
        state: "closed",
        state_reason: "not_planned",
      },
    ]);
  });

  it("closes the copy of a duplicate as not planned, and does not mention the issue that it duplicates", async () => {
    const octokit = fakeOctokit({
      items: [issue(5, { state: "closed", state_reason: "duplicate" })],
    });
    await run(input, { octokit });
    expect(octokit.updates[0].state_reason).toBe("not_planned");
    expect(JSON.stringify(octokit.created)).not.toContain("uplicate");
  });

  it("copies a pull request as an issue, without an issue type", async () => {
    const octokit = fakeOctokit({
      items: [
        issue(7, {
          type: { name: "Bug" },
          pull_request: { merged_at: "2026-10-01T00:00:00Z" },
          state: "closed",
        }),
        issue(8, {
          pull_request: { merged_at: null },
          state: "closed",
          state_reason: null,
        }),
        issue(9, { pull_request: { merged_at: null } }),
      ],
    });
    await run(input, { octokit });
    expect(octokit.created).toHaveLength(3);
    expect(octokit.created.every((request) => !("type" in request))).toBe(true);
    expect(octokit.updates.map((update) => update.state_reason)).toEqual([
      "completed",
      "not_planned",
    ]);
    expect(octokit.posted.map((comment) => comment.issue_number)).toEqual([
      7, 8, 9,
    ]);
  });

  it("copies in the order of the numbers", async () => {
    const octokit = fakeOctokit({ items: [issue(30), issue(10), issue(20)] });
    await run(input, { octokit });
    expect(octokit.created.map((request) => request.title)).toEqual([
      "Issue 10",
      "Issue 20",
      "Issue 30",
    ]);
  });

  it("skips an original that says that it was copied to the destination already", async () => {
    const octokit = fakeOctokit({
      items: [issue(1, { comments: 2 }), issue(2)],
      comments: {
        1: [{ body: "Thanks" }, { body: copiedComment(destination, 55) }],
      },
    });
    const result = await run(input, { octokit });
    expect(result.skipped).toEqual([{ from: `${source}#1`, to: 55 }]);
    expect(result.copied.map((copy) => copy.from)).toEqual([`${source}#2`]);
    expect(octokit.created.map((request) => request.title)).toEqual([
      "Issue 2",
    ]);
  });

  it("copies an original that was copied to another repository only", async () => {
    const octokit = fakeOctokit({
      items: [issue(1, { comments: 1 })],
      comments: { 1: [{ body: copiedComment("spring-projects/other", 55) }] },
    });
    const result = await run(input, { octokit });
    expect(result.copied).toHaveLength(1);
    expect(result.skipped).toEqual([]);
  });

  it("copies nothing when an assignee cannot be assigned in the destination, and names it", async () => {
    const octokit = fakeOctokit({
      items: [
        issue(1, { assignees: [{ login: "jgrandja" }] }),
        issue(2, { assignees: [{ login: "outsider" }] }),
        issue(3, { assignees: [{ login: "outsider" }] }),
      ],
      unassignable: ["outsider"],
    });
    await expect(run(input, { octokit })).rejects.toThrow(
      `outsider (${source}#2, ${source}#3) cannot be assigned in ${destination}`,
    );
    expect(octokit.created).toEqual([]);
    expect(octokit.posted).toEqual([]);
  });

  it("does not check the assignees of what is skipped", async () => {
    const octokit = fakeOctokit({
      items: [issue(1, { comments: 1, assignees: [{ login: "outsider" }] })],
      comments: { 1: [{ body: copiedComment(destination, 5) }] },
      unassignable: ["outsider"],
    });
    const result = await run(input, { octokit });
    expect(result.skipped).toHaveLength(1);
  });

  it("fails if the copy has other assignees than the original", async () => {
    const octokit = fakeOctokit({
      items: [issue(1, { assignees: [{ login: "jgrandja" }] })],
      dropAssignees: true,
    });
    await expect(run(input, { octokit })).rejects.toThrow(
      `${destination}#101 has the assignees [], and ${source}#1 has [jgrandja]`,
    );
  });

  it("fails if the source has no such milestone", async () => {
    const octokit = fakeOctokit({ sourceMilestones: [] });
    await expect(run(input, { octokit })).rejects.toThrow(
      `${source} has no milestone 7.0.1`,
    );
  });

  it("fails if the destination has no such milestone, and says to create it", async () => {
    const octokit = fakeOctokit({
      items: [issue(1)],
      destinationMilestones: [],
    });
    await expect(run(input, { octokit })).rejects.toThrow(
      `${destination} has no milestone 7.0.1: create it first`,
    );
    expect(octokit.created).toEqual([]);
  });

  it("fails if the source and the destination are the same repository", async () => {
    const octokit = fakeOctokit();
    await expect(
      run({ ...input, destination: source.toUpperCase() }, { octokit }),
    ).rejects.toThrow("both");
  });

  it("copies nothing from a milestone that has no issues", async () => {
    const octokit = fakeOctokit();
    expect(await run(input, { octokit })).toEqual({ copied: [], skipped: [] });
  });
});

describe("closeReason", () => {
  it("keeps completed and not planned, and makes a duplicate not planned", () => {
    expect(closeReason({ state_reason: "completed" })).toBe("completed");
    expect(closeReason({ state_reason: "not_planned" })).toBe("not_planned");
    expect(closeReason({ state_reason: "duplicate" })).toBe("not_planned");
    expect(closeReason({ state_reason: null })).toBe("completed");
  });
});
