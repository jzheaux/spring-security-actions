import { describe, expect, it } from "vitest";
import { closeReason, copiedComment, run, summaryOf } from "../src/index.js";

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
  destinationLabels = ["type: bug", "in: oauth2"],
} = {}) {
  const created = [];
  const labelsCreated = [];
  const posted = [];
  const updates = [];
  let next = 100;
  return {
    created,
    labelsCreated,
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
        listLabelsForRepo: () => destinationLabels.map((name) => ({ name })),
        createLabel: async (request) => {
          labelsCreated.push(request);
        },
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
  it("copies an issue with its title, labels, assignees and the milestone of the destination, and nothing more", async () => {
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
        labels: ["type: bug", "in: oauth2"],
        assignees: ["jgrandja"],
        milestone: 8,
        type: "Bug",
      },
    ]);
    expect(result.copied).toMatchObject([
      {
        from: `${source}#586`,
        to: `${destination}#101`,
        url: `https://github.com/${destination}/issues/101`,
        title: "Fix CVE-2026-41008",
        labels: ["type: bug", "in: oauth2"],
        assignees: ["jgrandja"],
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

  it("never copies the body, which can name the source, or the comments", async () => {
    const octokit = fakeOctokit({
      items: [issue(586, { body: "Found in spring-security-commercial#5" })],
    });
    await run(input, { octokit });
    expect(octokit.created[0]).not.toHaveProperty("body");
    expect(octokit.created[0].title).toBe("Issue 586");
    expect(octokit.created[0].labels).toEqual(["type: bug"]);
    expect(JSON.stringify(octokit.created)).not.toContain("commercial");
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

  it("copies without an assignee who cannot be assigned in the destination, and says so", async () => {
    const octokit = fakeOctokit({
      items: [
        issue(1, { assignees: [{ login: "jgrandja" }] }),
        issue(2, { assignees: [{ login: "outsider" }, { login: "jgrandja" }] }),
        issue(3, { assignees: [{ login: "outsider" }] }),
      ],
      unassignable: ["outsider"],
    });
    const result = await run(input, { octokit });
    expect(octokit.created.map((request) => request.assignees)).toEqual([
      ["jgrandja"],
      ["jgrandja"],
      [],
    ]);
    expect(result.dropped).toEqual([
      { login: "outsider", issues: [`${source}#2`, `${source}#3`] },
    ]);
    expect(result.copied).toHaveLength(3);
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
      `${destination}#101 has the assignees [], and ${source}#1 has [jgrandja] that can be assigned`,
    );
  });

  it("fails if the source has no such milestone", async () => {
    const octokit = fakeOctokit({ sourceMilestones: [] });
    await expect(run(input, { octokit })).rejects.toThrow(
      `${source} has no milestone 7.0.1`,
    );
  });

  it("fails if the destination has no such milestone, and does not create it", async () => {
    const octokit = fakeOctokit({
      items: [issue(1)],
      destinationMilestones: [],
    });
    await expect(run(input, { octokit })).rejects.toThrow(
      `${destination} has no milestone 7.0.1: it is not created`,
    );
    expect(octokit.created).toEqual([]);
    expect(octokit.labelsCreated).toEqual([]);
  });

  it("fails if the source and the destination are the same repository", async () => {
    const octokit = fakeOctokit();
    await expect(
      run({ ...input, destination: source.toUpperCase() }, { octokit }),
    ).rejects.toThrow("both");
  });

  it("copies nothing from a milestone that has no issues", async () => {
    const octokit = fakeOctokit();
    expect(await run(input, { octokit })).toEqual({
      copied: [],
      skipped: [],
      labelsToCreate: [],
      dropped: [],
      dryRun: false,
    });
  });
});

describe("the labels", () => {
  const label = (name, color, description) => ({ name, color, description });

  it("creates a label that the destination lacks, like the one of the source, before the issue", async () => {
    const octokit = fakeOctokit({
      items: [
        issue(1, {
          labels: [
            label("type: bug", "e3d9fc", "A general bug"),
            label(
              "status: forward-port",
              "fef2c0",
              "An issue tracking a forward-port",
            ),
          ],
        }),
      ],
    });
    const result = await run(input, { octokit });
    expect(octokit.labelsCreated).toEqual([
      {
        owner: "spring-projects",
        repo: "spring-security",
        name: "status: forward-port",
        color: "fef2c0",
        description: "An issue tracking a forward-port",
      },
    ]);
    expect(result.labelsToCreate).toEqual(["status: forward-port"]);
    expect(octokit.created[0].labels).toEqual([
      "type: bug",
      "status: forward-port",
    ]);
  });

  it("compares the names without their case, and creates a label once", async () => {
    const octokit = fakeOctokit({
      items: [
        issue(1, {
          labels: [label("TYPE: BUG", "e3d9fc"), label("new", "000000")],
        }),
        issue(2, { labels: [label("new", "000000")] }),
      ],
    });
    await run(input, { octokit });
    expect(octokit.labelsCreated.map((request) => request.name)).toEqual([
      "new",
    ]);
  });
});

describe("a dry run", () => {
  it("writes nothing, and says what would be copied, with the labels and the assignees", async () => {
    const octokit = fakeOctokit({
      items: [
        issue(1, {
          labels: [{ name: "brand new", color: "ffffff" }],
          assignees: [{ login: "outsider" }, { login: "jgrandja" }],
          state: "closed",
        }),
        issue(2),
      ],
      unassignable: ["outsider"],
    });
    const result = await run({ ...input, dryRun: true }, { octokit });
    expect(octokit.created).toEqual([]);
    expect(octokit.labelsCreated).toEqual([]);
    expect(octokit.posted).toEqual([]);
    expect(octokit.updates).toEqual([]);
    expect(result.dryRun).toBe(true);
    expect(result.labelsToCreate).toEqual(["brand new"]);
    expect(
      result.copied.map((item) => [item.from, item.to, item.assignees]),
    ).toEqual([
      [`${source}#1`, "", ["jgrandja"]],
      [`${source}#2`, "", []],
    ]);
    expect(result.dropped).toEqual([
      { login: "outsider", issues: [`${source}#1`] },
    ]);
  });

  it("still skips what was copied already", async () => {
    const octokit = fakeOctokit({
      items: [issue(1, { comments: 1 })],
      comments: { 1: [{ body: copiedComment(destination, 5) }] },
    });
    const result = await run({ ...input, dryRun: true }, { octokit });
    expect(result.skipped).toHaveLength(1);
    expect(result.copied).toEqual([]);
  });
});

describe("the summary", () => {
  const result = {
    copied: [
      {
        from: `${source}#934`,
        to: `${destination}#20001`,
        title: "Merge Validate username length",
        state: "closed",
        labels: ["type: bug", "in: rsocket"],
        assignees: ["rwinch"],
      },
    ],
    skipped: [],
    labelsToCreate: [],
    dropped: [],
    dryRun: false,
  };
  const names = { source, destination, milestone: "7.1.3" };

  it("links the original and the copy of a real run", () => {
    const text = summaryOf(names, result);
    expect(text).toContain(
      "### Issues of the milestone 7.1.3: spring-projects/spring-security-commercial to spring-projects/spring-security",
    );
    expect(text).toContain(
      "[spring-projects/spring-security-commercial#934](https://github.com/spring-projects/spring-security-commercial/issues/934) | [spring-projects/spring-security#20001](https://github.com/spring-projects/spring-security/issues/20001)",
    );
    expect(text).toContain(
      "Labels created in spring-projects/spring-security: none.",
    );
    expect(text).toContain("Assignees left out: none.");
  });

  it("says that a dry run would copy, with the labels and the assignees", () => {
    const text = summaryOf(names, {
      ...result,
      dryRun: true,
      copied: [{ ...result.copied[0], to: "" }],
      labelsToCreate: ["status: forward-port"],
      dropped: [{ login: "outsider", issues: [`${source}#934`] }],
    });
    expect(text).toContain("(dry run)");
    expect(text).toContain("Would be copied:");
    expect(text).not.toContain("| Copy |");
    expect(text).toContain(
      "Labels to create in spring-projects/spring-security: `status: forward-port`.",
    );
    expect(text).toContain(
      "outsider ([spring-projects/spring-security-commercial#934]",
    );
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
