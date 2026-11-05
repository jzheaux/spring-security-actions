import { afterEach, describe, expect, it } from "vitest";
import {
  ensureIssues,
  issueTitle,
  parseLabels,
  updatesToMake,
  updatesOf,
} from "../src/index.js";
import { createOctokit } from "../src/octokit.js";
import { startFakeGitHub } from "./support/fake-github.js";
import { runAction } from "./support/run-action.js";

const REPO = "tutorial/spring-merge";
// the milestones of test/fixtures/milestones.json
const M_7_0_1 = 3;
const M_7_0_2 = 5;

const issue = (number, title, state, milestone = M_7_0_1, extra = {}) => ({
  number,
  title,
  state,
  milestone: { number: milestone },
  ...extra,
});

describe("issueTitle", () => {
  it("is the name and the version", () => {
    expect(issueTitle("spring-framework", "7.0.10")).toBe(
      "Update spring-framework to 7.0.10",
    );
  });
});

describe("parseLabels", () => {
  it("splits on commas and lines, and drops the empty ones", () => {
    expect(parseLabels("a, b\nc,, \n d e ")).toEqual(["a", "b", "c", "d e"]);
  });

  it("keeps a label with a colon and spaces", () => {
    expect(parseLabels("type: dependency-upgrade")).toEqual([
      "type: dependency-upgrade",
    ]);
  });

  it("is none for nothing", () => {
    expect(parseLabels("")).toEqual([]);
    expect(parseLabels(undefined)).toEqual([]);
  });
});

describe("updatesToMake", () => {
  it("keeps the version and the issue only", () => {
    expect(
      updatesToMake({
        micrometer: { version: "1.16.8", issue: 40, existed: true },
        "spring-framework": { version: "7.0.10", issue: 41, existed: false },
      }),
    ).toEqual({
      micrometer: { version: "1.16.8", issue: 40 },
      "spring-framework": { version: "7.0.10", issue: 41 },
    });
  });

  it("is nothing for nothing", () => {
    expect(updatesToMake({})).toEqual({});
  });
});

describe("updatesOf", () => {
  it("lists the updates in the order of the names, from versions or objects", () => {
    expect(
      updatesOf({ b: "2.0.0", a: { version: "1.0.0", issue: 5 } }),
    ).toEqual([
      { dependency: "a", version: "1.0.0" },
      { dependency: "b", version: "2.0.0" },
    ]);
  });

  it.each([null, [], "x", 3])("wants an object, not %j", (versions) => {
    expect(() => updatesOf(versions)).toThrow("must be an object");
  });

  it("wants a version for each", () => {
    expect(() => updatesOf({ a: {} })).toThrow(
      "The update of a has no version",
    );
  });
});

describe("ensureIssues", () => {
  let fake;
  afterEach(() => fake?.close());

  const ensure = async (options = {}, { issues = [], token } = {}) => {
    fake = await startFakeGitHub({ issues });
    const log = [];
    const { issues: result, removed } = await ensureIssues(
      {
        repository: REPO,
        milestone: "7.0.1",
        versions: { "spring-framework": "7.0.10", micrometer: "1.16.8" },
        ...options,
      },
      {
        octokit: createOctokit({ baseUrl: fake.url, token }),
        log: (l) => log.push(l),
      },
    );
    return { result, log, removed };
  };

  it("creates the issues that are missing, in the milestone", async () => {
    const { result } = await ensure({ labels: ["type: dependency-upgrade"] });
    expect(result).toEqual({
      micrometer: {
        version: "1.16.8",
        issue: 1,
        existed: false,
      },
      "spring-framework": {
        version: "7.0.10",
        issue: 2,
        existed: false,
      },
    });
    expect(fake.issues).toHaveLength(2);
    expect(fake.issues[0]).toMatchObject({
      title: "Update micrometer to 1.16.8",
      state: "closed",
      milestone: { number: M_7_0_1, title: "7.0.1" },
      labels: [{ name: "type: dependency-upgrade" }],
    });
    expect(fake.issues[1].state).toBe("closed");
    // no body
    const created = fake.requests.find((r) => r.method === "POST");
    expect(created.body).not.toHaveProperty("body");
  });

  it("leaves the issues that it creates open for close false", async () => {
    const { result, log } = await ensure({ close: false });
    expect(result.micrometer).toMatchObject({ issue: 1, existed: false });
    expect(fake.issues.map((i) => i.state)).toEqual(["open", "open"]);
    expect(fake.requests.some((r) => r.method === "PATCH")).toBe(false);
    expect(log).toContain("micrometer 1.16.8: issue 1 created");
  });

  it("does not make an issue that exists, open", async () => {
    const { result, log } = await ensure(
      {},
      {
        issues: [
          issue(40, "Update spring-framework to 7.0.10", "open"),
          issue(41, "Update micrometer to 1.16.8", "open"),
        ],
      },
    );
    expect(result["spring-framework"]).toEqual({
      version: "7.0.10",
      issue: 40,
      existed: true,
    });
    expect(result.micrometer.issue).toBe(41);
    expect(fake.issues).toHaveLength(2); // none created
    expect(fake.requests.some((r) => r.method === "POST")).toBe(false);
    expect(log).toContain("spring-framework 7.0.10: issue 40 exists");
  });

  it("does not make an issue that exists, closed", async () => {
    const { result, log } = await ensure(
      {},
      { issues: [issue(40, "Update spring-framework to 7.0.10", "closed")] },
    );
    expect(result["spring-framework"]).toEqual({
      version: "7.0.10",
      issue: 40,
      existed: true,
    });
    expect(result.micrometer.existed).toBe(false); // the other was created
    expect(
      fake.issues.filter((i) => i.title.includes("spring-framework")),
    ).toHaveLength(1);
    expect(log).toContain("spring-framework 7.0.10: issue 40 exists");
  });

  describe("an update that is not in the train any more", () => {
    const labelled = (number, title, milestone = M_7_0_1) =>
      issue(number, title, "closed", milestone, {
        labels: [{ name: "type: dependency-upgrade" }],
      });

    it("is commented on, and taken out of the milestone", async () => {
      const { removed } = await ensure(
        { labels: ["type: dependency-upgrade"] },
        { issues: [labelled(40, "Update jackson to 2.20.0")] },
      );
      expect(removed).toEqual([
        { issue: 40, title: "Update jackson to 2.20.0" },
      ]);
      expect(fake.comments).toEqual([
        {
          issue: 40,
          body: "Removed from the milestone 7.0.1 because `jackson 2.20.0` was not found in the release train on the latest run.",
        },
      ]);
      expect(fake.issues[0].milestone).toBeNull();
    });

    it("is not found again by a run that is done again", async () => {
      await ensure(
        { labels: ["type: dependency-upgrade"] },
        { issues: [labelled(40, "Update jackson to 2.20.0")] },
      );
      const second = await ensureIssues(
        {
          repository: REPO,
          milestone: "7.0.1",
          versions: { "spring-framework": "7.0.10", micrometer: "1.16.8" },
          labels: ["type: dependency-upgrade"],
        },
        { octokit: createOctokit({ baseUrl: fake.url }) },
      );
      expect(second.removed).toEqual([]);
      expect(fake.comments).toHaveLength(1);
    });

    it("is the old version of a dependency that has a new one", async () => {
      const { removed } = await ensure(
        { labels: ["type: dependency-upgrade"] },
        { issues: [labelled(40, "Update micrometer to 1.16.7")] },
      );
      expect(removed).toHaveLength(1);
    });

    it("is left in the milestone if it is an update of the train", async () => {
      const { removed } = await ensure(
        { labels: ["type: dependency-upgrade"] },
        { issues: [labelled(40, "Update micrometer to 1.16.8")] },
      );
      expect(removed).toEqual([]);
      expect(fake.comments).toEqual([]);
    });

    it("is left alone if it has not the labels, or is not the title of an update", async () => {
      const { removed } = await ensure(
        { labels: ["type: dependency-upgrade"] },
        {
          issues: [
            issue(40, "Update jackson to 2.20.0", "closed"),
            labelled(41, "Fix the build"),
            labelled(42, "Update jackson to 2.20.0", M_7_0_2),
          ],
        },
      );
      expect(removed).toEqual([]);
      expect(fake.comments).toEqual([]);
    });
  });

  it("is done again without making another", async () => {
    const first = await ensure();
    const { issues: second } = await ensureIssues(
      {
        repository: REPO,
        milestone: "7.0.1",
        versions: { "spring-framework": "7.0.10", micrometer: "1.16.8" },
      },
      { octokit: createOctokit({ baseUrl: fake.url }) },
    );
    expect(fake.issues).toHaveLength(2);
    expect(second["spring-framework"]).toMatchObject({
      issue: first.result["spring-framework"].issue,
      existed: true,
    });
  });

  it("looks in the milestone only", async () => {
    const { result } = await ensure(
      { versions: { micrometer: "1.16.8" } },
      { issues: [issue(40, "Update micrometer to 1.16.8", "open", M_7_0_2)] },
    );
    expect(result.micrometer.existed).toBe(false);
    expect(fake.issues).toHaveLength(2);
  });

  it("takes the title exactly", async () => {
    const { result } = await ensure(
      { versions: { "spring-framework": "7.0.10" } },
      {
        issues: [
          issue(40, "Update spring-framework to 7.0.100", "open"),
          issue(41, "update spring-framework to 7.0.10", "open"),
          issue(42, "Update spring-framework to 7.0.10 ", "open"),
          issue(43, "Update spring-framework to 7.0.1", "open"),
        ],
      },
    );
    expect(result["spring-framework"].existed).toBe(false);
  });

  it("does not take a pull request for an issue", async () => {
    const { result } = await ensure(
      { versions: { micrometer: "1.16.8" } },
      {
        issues: [
          issue(40, "Update micrometer to 1.16.8", "open", M_7_0_1, {
            pull_request: { url: "x" },
          }),
        ],
      },
    );
    expect(result.micrometer).toMatchObject({ existed: false, issue: 41 });
  });

  it("takes an open issue of two with the title, and else the first", async () => {
    const title = "Update micrometer to 1.16.8";
    let { result } = await ensure(
      { versions: { micrometer: "1.16.8" } },
      {
        issues: [
          issue(50, title, "closed"),
          issue(51, title, "open"),
          issue(52, title, "open"),
        ],
      },
    );
    expect(result.micrometer.issue).toBe(51);
    await fake.close();
    ({ result } = await ensure(
      { versions: { micrometer: "1.16.8" } },
      { issues: [issue(53, title, "closed"), issue(52, title, "closed")] },
    ));
    expect(result.micrometer).toMatchObject({ issue: 52 });
  });

  it("finds an issue on another page", async () => {
    const many = Array.from({ length: 230 }, (_, i) =>
      issue(i + 1, `Update other-${i} to 1.0.0`, "closed"),
    );
    many.push(issue(300, "Update micrometer to 1.16.8", "open"));
    const { result } = await ensure(
      { versions: { micrometer: "1.16.8" } },
      { issues: many },
    );
    expect(result.micrometer).toMatchObject({ issue: 300, existed: true });
    expect(
      fake.requests.filter((r) =>
        r.path.startsWith("/repos/tutorial/spring-merge/issues?"),
      ),
    ).toHaveLength(3);
  });

  it("sends the labels and the type when given, and not otherwise", async () => {
    await ensure({ versions: { micrometer: "1.16.8" } });
    const plain = fake.requests.find((r) => r.method === "POST").body;
    expect(plain).not.toHaveProperty("labels");
    expect(plain).not.toHaveProperty("type");
    await fake.close();
    await ensure({
      versions: { micrometer: "1.16.8" },
      labels: ["a", "b"],
      type: "Task",
    });
    const given = fake.requests.find((r) => r.method === "POST").body;
    expect(given).toMatchObject({
      labels: ["a", "b"],
      type: "Task",
      milestone: M_7_0_1,
    });
  });

  it("sends the token", async () => {
    await ensure({}, { token: "the-token" });
    expect(
      fake.requests.every((r) => r.headers.authorization === "token the-token"),
    ).toBe(true);
  });

  it("makes nothing for no updates", async () => {
    const { result } = await ensure({ versions: {} });
    expect(result).toEqual({});
    expect(fake.issues).toHaveLength(0);
  });

  it("can use a closed milestone", async () => {
    const { result } = await ensure({
      milestone: "7.0.0",
      versions: { micrometer: "1.16.8" },
    });
    expect(result.micrometer.existed).toBe(false);
  });

  describe("the lag of GitHub, which lists a new issue a few seconds later", () => {
    const versions = { micrometer: "1.16.8" };
    const deps = (sleeps, warnings = []) => ({
      octokit: createOctokit({ baseUrl: fake.url }),
      sleep: async (milliseconds) => sleeps.push(milliseconds),
      warn: (line) => warnings.push(line),
      intervalMs: 2000,
      attempts: 4,
    });

    it("waits until the issues that it created are listed, and not longer", async () => {
      fake = await startFakeGitHub();
      fake.lag = 2; // the new issue is not in the next two lists
      const sleeps = [];
      const warnings = [];
      const { issues: result } = await ensureIssues(
        { repository: REPO, milestone: "7.0.1", versions },
        deps(sleeps, warnings),
      );
      expect(result.micrometer.issue).toBe(1);
      expect(sleeps).toEqual([2000, 2000]);
      expect(warnings).toEqual([]);
    });

    it("does not wait if they are listed at once", async () => {
      fake = await startFakeGitHub();
      const sleeps = [];
      await ensureIssues(
        { repository: REPO, milestone: "7.0.1", versions },
        deps(sleeps),
      );
      expect(sleeps).toEqual([]);
    });

    it("warns if they are still not listed, and goes on", async () => {
      fake = await startFakeGitHub();
      fake.lag = 100;
      const sleeps = [];
      const warnings = [];
      const { issues: result } = await ensureIssues(
        { repository: REPO, milestone: "7.0.1", versions },
        deps(sleeps, warnings),
      );
      expect(result.micrometer.existed).toBe(false);
      expect(sleeps).toHaveLength(4);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("The issues 1 are not in the list");
      expect(warnings[0]).toContain("after 8 seconds");
    });

    it("does not wait if it created nothing", async () => {
      fake = await startFakeGitHub({
        issues: [issue(40, "Update micrometer to 1.16.8", "open")],
      });
      fake.lag = 100;
      const sleeps = [];
      await ensureIssues(
        { repository: REPO, milestone: "7.0.1", versions },
        deps(sleeps),
      );
      expect(sleeps).toEqual([]);
      expect(fake.listRequests).toBe(1); // only the list that it needed
    });

    it("waits for each of the issues that it created", async () => {
      fake = await startFakeGitHub();
      fake.lag = 1;
      const sleeps = [];
      const { issues: result } = await ensureIssues(
        {
          repository: REPO,
          milestone: "7.0.1",
          versions: { micrometer: "1.16.8", reactor: "2025.0.8" },
        },
        deps(sleeps),
      );
      expect(Object.values(result).map((i) => i.issue)).toEqual([1, 2]);
      // the second is hidden for one list more than the first, and it is waited for
      expect(sleeps.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("fails", () => {
    it("for a milestone that does not exist, and creates nothing", async () => {
      await expect(ensure({ milestone: "9.9.9" })).rejects.toThrow(
        `${REPO} has no milestone 9.9.9`,
      );
      expect(fake.issues).toHaveLength(0);
    });

    it("for a repository that cannot be read", async () => {
      await expect(ensure({ repository: "missing/missing" })).rejects.toThrow(
        /Reading the milestones of missing\/missing failed with 404.*cannot read it/,
      );
    });

    it("if the milestone or the repository is not given", async () => {
      await expect(ensure({ milestone: "" })).rejects.toThrow(
        "milestone is required",
      );
      await expect(ensure({ repository: "nonsense" })).rejects.toThrow(
        "expected owner/repo",
      );
    });

    it("if the token may not create issues, and says what it was doing", async () => {
      fake = await startFakeGitHub();
      fake.createFailure = {
        status: 403,
        message: "Resource not accessible by personal access token",
      };
      await expect(
        ensureIssues(
          {
            repository: REPO,
            milestone: "7.0.1",
            versions: { micrometer: "1.16.8" },
          },
          { octokit: createOctokit({ baseUrl: fake.url }) },
        ),
      ).rejects.toThrow(
        /Creating the issue "Update micrometer to 1.16.8" in tutorial\/spring-merge failed with 403.*check its permissions/,
      );
    });

    it("if GitHub refuses a label or a type", async () => {
      fake = await startFakeGitHub();
      fake.createFailure = { status: 422, message: "Validation Failed" };
      await expect(
        ensureIssues(
          {
            repository: REPO,
            milestone: "7.0.1",
            versions: { micrometer: "1.16.8" },
            type: "Nope",
          },
          { octokit: createOctokit({ baseUrl: fake.url }) },
        ),
      ).rejects.toThrow(/failed with 422.*label, a milestone or an issue type/);
    });
  });
});

// The actions run as programs: the sources, and the bundle that GitHub runs (dist/).
describe.each([["src/index.js"], ["dist/index.js"]])(
  "the program %s",
  (entry) => {
    let fake;
    afterEach(() => fake?.close());

    const inputs = (more = {}) => ({
      versions: JSON.stringify({
        "spring-framework": "7.0.10",
        micrometer: "1.16.8",
      }),
      repository: REPO,
      milestone: "7.0.1",
      labels: "type: dependency-upgrade",
      token: "the-token",
      ...more,
    });

    it("creates the issues, closes them, and writes them as an output", async () => {
      fake = await startFakeGitHub({
        issues: [issue(40, "Update micrometer to 1.16.8", "closed")],
      });
      const result = await runAction(entry, inputs(), {
        GITHUB_API_URL: fake.url,
      });
      expect(result.code).toBe(0);
      expect(result.outputs.count).toBe("2");
      expect(JSON.parse(result.outputs.issues)).toEqual({
        micrometer: { version: "1.16.8", issue: 40, existed: true },
        "spring-framework": { version: "7.0.10", issue: 41, existed: false },
      });
      expect(fake.issues.at(-1)).toMatchObject({
        state: "closed",
        labels: [{ name: "type: dependency-upgrade" }],
      });
      expect(result.stdout).toContain(
        "2 issues: 1 created and closed, 1 there already, 0 removed from the milestone",
      );
    });

    it("leaves the issues open for the input close false", async () => {
      fake = await startFakeGitHub();
      const result = await runAction(entry, inputs({ close: "false" }), {
        GITHUB_API_URL: fake.url,
      });
      expect(result.code).toBe(0);
      expect(fake.issues.map((i) => i.state)).toEqual(["open", "open"]);
      expect(result.stdout).toContain("2 issues: 2 created, 0 there already");
    });

    it("gives every update as an output", async () => {
      fake = await startFakeGitHub({
        issues: [issue(40, "Update micrometer to 1.16.8", "closed")],
      });
      const result = await runAction(entry, inputs(), {
        GITHUB_API_URL: fake.url,
      });
      expect(JSON.parse(result.outputs.updates)).toEqual({
        micrometer: { version: "1.16.8", issue: 40 },
        "spring-framework": { version: "7.0.10", issue: 41 },
      });
    });

    it("says the issues that are taken out of the milestone", async () => {
      fake = await startFakeGitHub({
        issues: [
          issue(40, "Update jackson to 2.20.0", "closed", M_7_0_1, {
            labels: [{ name: "type: dependency-upgrade" }],
          }),
        ],
      });
      const result = await runAction(entry, inputs(), {
        GITHUB_API_URL: fake.url,
      });
      expect(JSON.parse(result.outputs.removed)).toEqual([
        { issue: 40, title: "Update jackson to 2.20.0" },
      ]);
      expect(result.stdout).toContain(
        '::notice title=Removed from the milestone::"Update jackson to 2.20.0" (#40) is not in the release train any more: removed from the milestone',
      );
      expect(fake.comments).toHaveLength(1);
    });

    it("fails with an error that GitHub shows, and creates nothing", async () => {
      fake = await startFakeGitHub();
      const result = await runAction(entry, inputs({ milestone: "9.9.9" }), {
        GITHUB_API_URL: fake.url,
      });
      expect(result.code).toBe(1);
      expect(result.stdout).toContain(
        "::error::tutorial/spring-merge has no milestone 9.9.9",
      );
      expect(fake.issues).toHaveLength(0);
    });

    it("fails for versions that are not JSON", async () => {
      fake = await startFakeGitHub();
      const result = await runAction(entry, inputs({ versions: "{ no" }), {
        GITHUB_API_URL: fake.url,
      });
      expect(result.code).toBe(1);
      expect(result.stdout).toContain("The input versions is not JSON");
    });
  },
);
