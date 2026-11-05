import { describe, expect, it } from "vitest";
import { describeProblems, planFreeze } from "../src/index.js";
import { createFixture, git, trainWith } from "./support/freeze-fixture.js";

const due = "2026-11-19T00:00:00Z";
let numbers = 0;
const milestone = (title, state = "open", issues = {}) => ({
  title,
  state,
  due_on: due,
  number: ++numbers,
  html_url: `https://github.com/x/y/milestone/${numbers}`,
  open_issues: 0,
  closed_issues: 0,
  ...issues,
});

const ossMilestones = [
  milestone("7.0.5"),
  milestone("7.1.1"),
  milestone("7.2.0-M1", "closed"),
  milestone("7.2.0-M2"),
];
const commercialMilestones = [
  milestone("6.5.11"),
  milestone("7.0.5.1"),
  milestone("7.1.1.1"),
];

const joined = { joined: "a1" };
const train = (overrides = {}) =>
  trainWith("spring-security", {
    "7.0.5": joined,
    "7.0.5.1": joined,
    "7.1.1": joined,
    "7.1.1.1": joined,
    "7.2.0-M2": joined,
    "6.5.11": joined,
    ...overrides,
  });

function setup(options, inputs = {}, milestones = {}) {
  const fixture = createFixture(options);
  const run = () =>
    planFreeze(
      {
        directory: fixture.work,
        project: "spring-security",
        hostRepository: "spring-projects/spring-security-commercial",
        ossRepository: "spring-projects/spring-security",
        ossUrl: fixture.oss,
        ossBranches: ["7.0.x", "7.1.x", "main"],
        ltsGenerations: ["6.5.x"],
        train: "2026.11.19",
        trainFound: true,
        trainDocument: train(),
        ...inputs,
      },
      {
        listMilestones: async (repository) =>
          repository.endsWith("-commercial")
            ? (milestones.commercial ?? commercialMilestones)
            : (milestones.oss ?? ossMilestones),
      },
    );
  return { fixture, run };
}

describe("planFreeze", () => {
  it("plans the next version of every branch, and the releases to mark ready", async () => {
    const plan = await setup().run();
    expect(plan.problems).toEqual([]);
    expect(plan.oss).toEqual([
      {
        generation: "7.0.x",
        branch: "7.0.x",
        frozen: "embargoed/frozen/7.0.x",
        active: "embargoed/active/7.0.x",
        current: "7.0.5-SNAPSHOT",
        next: "7.0.6-SNAPSHOT",
        bump: true,
      },
      {
        generation: "7.1.x",
        branch: "7.1.x",
        frozen: "embargoed/frozen/7.1.x",
        active: "embargoed/active/7.1.x",
        current: "7.1.1-SNAPSHOT",
        next: "7.1.2-SNAPSHOT",
        bump: true,
      },
      {
        generation: "main",
        branch: "main",
        frozen: "embargoed/frozen/main",
        active: "embargoed/active/main",
        current: "7.2.0-SNAPSHOT",
        next: "7.2.0-SNAPSHOT",
        bump: false,
      },
    ]);
    expect(plan.lts).toEqual([
      {
        generation: "6.5.x",
        branch: "embargoed/lts/6.5.x",
        current: "6.5.11-SNAPSHOT",
        next: "6.5.12-SNAPSHOT",
        bump: true,
      },
    ]);
    expect(plan.releases.map((r) => r.branch)).toEqual(
      expect.arrayContaining([
        "release/7.0.5",
        "release/7.0.5.1",
        "release/7.2.0-M2",
        "release/6.5.11",
      ]),
    );
    const first = plan.releases.find((r) => r.version === "7.0.5");
    expect(first.of).toEqual(["7.0.x", "embargoed/frozen/7.0.x"]);
    expect(first.builtFrom).toBe("embargoed/frozen/7.0.x");
    expect(plan.releases.find((r) => r.version === "7.0.5.1").of).toEqual([
      "embargoed/active/7.0.x",
    ]);
  });

  it("plans the milestone of each release: OSS for the OSS releases, commercial for a hotfix and for long-term support", async () => {
    const oss = [
      milestone("7.0.5", "open", { open_issues: 2, closed_issues: 9 }),
      milestone("7.1.1"),
      milestone("7.2.0-M2"),
    ];
    const commercial = [
      milestone("6.5.11"),
      milestone("7.0.5.1"),
      milestone("7.1.1.1"),
    ];
    const plan = await setup({}, {}, { oss, commercial }).run();
    const of = (version) => plan.releases.find((r) => r.version === version);
    expect(of("7.0.5")).toMatchObject({
      hotfix: false,
      milestone: {
        repository: "spring-projects/spring-security",
        title: "7.0.5",
        number: oss[0].number,
        url: oss[0].html_url,
        state: "open",
        open: 2,
        closed: 9,
      },
    });
    expect(of("7.0.5.1")).toMatchObject({
      hotfix: true,
      milestone: {
        repository: "spring-projects/spring-security-commercial",
        number: commercial[1].number,
      },
    });
    expect(of("6.5.11")).toMatchObject({
      hotfix: false,
      milestone: { repository: "spring-projects/spring-security-commercial" },
    });
  });

  it("says that the milestone of a hotfix does not exist", async () => {
    const plan = await setup(
      {},
      {},
      { commercial: [milestone("6.5.11"), milestone("7.1.1.1")] },
    ).run();
    expect(plan.problems).toEqual([
      expect.stringMatching(
        /the milestone 7\.0\.5\.1 of the hotfix does not exist in spring-projects\/spring-security-commercial, and embargoed\/active\/7\.0\.x needs it/,
      ),
    ]);
  });

  it("changes nothing in the branches: it only adds and fetches the OSS remote", async () => {
    const { fixture, run } = setup();
    const before = git(
      fixture.work,
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      "refs/heads",
      "refs/remotes/origin",
    );
    await run();
    expect(
      git(
        fixture.work,
        "for-each-ref",
        "--format=%(refname) %(objectname)",
        "refs/heads",
        "refs/remotes/origin",
      ),
    ).toBe(before);
    expect(git(fixture.work, "remote", "get-url", "oss")).toBe(fixture.oss);
    expect(git(fixture.work, "rev-parse", "refs/remotes/oss/7.0.x")).toBe(
      git(fixture.oss, "rev-parse", "7.0.x"),
    );
  });

  it("can be run again: the remote is there already", async () => {
    const { run } = setup();
    await run();
    await expect(run()).resolves.toMatchObject({ problems: [] });
  });

  it("plans no hotfix for an active branch that has nothing the frozen one lacks, nor for a .0 that is not GA", async () => {
    const { fixture, run } = setup(
      {},
      { ossBranches: ["7.1.x"], ltsGenerations: [] },
    );
    git(
      fixture.seed,
      "push",
      "-q",
      "--force",
      "commercial",
      "embargoed/frozen/7.1.x:embargoed/active/7.1.x",
    );
    git(fixture.work, "fetch", "-q", "origin");
    const plan = await run();
    expect(plan.problems).toEqual([]);
    expect(plan.releases.map((r) => r.version)).toEqual(["7.1.1"]);
  });

  it("plans the hotfix of a .0 version only for its GA", async () => {
    const { fixture, run } = setup(
      {},
      { ossBranches: ["main"], ltsGenerations: [], trainDocument: train() },
      { oss: [milestone("7.2.0")], commercial: [milestone("7.2.0.1")] },
    );
    const plan = await run();
    // the GA milestone is the next release: its release branch and the hotfix are needed
    expect(plan.oss[0].next).toBe("7.2.1-SNAPSHOT");
    expect(plan.releases.map((r) => r.version)).toEqual(["7.2.0", "7.2.0.1"]);
    expect(fixture).toBeDefined();
  });

  describe("everything that stops the freeze", () => {
    it("says that a release has not joined the release train", async () => {
      const { run } = setup({}, { trainDocument: train({ "7.1.1": {} }) });
      const plan = await run();
      expect(plan.problems).toEqual([
        expect.stringMatching(
          /release\/7\.1\.1 has not joined the release train 2026\.11\.19/,
        ),
      ]);
    });

    it("does not stop for a release that is ready already: it is not marked ready again", async () => {
      const { run } = setup(
        {},
        { trainDocument: train({ "7.0.5": { joined: "a", ready: "b" } }) },
      );
      const plan = await run();
      expect(plan.problems).toEqual([]);
      expect(plan.releases.map((r) => [r.version, r.alreadyReady])).toEqual(
        expect.arrayContaining([
          ["7.0.5", true],
          ["7.0.5.1", false],
          ["7.1.1", false],
        ]),
      );
      // its branches are bumped all the same
      expect(plan.oss[0]).toMatchObject({ next: "7.0.6-SNAPSHOT", bump: true });
    });

    it("says that the release train has not been created, for every release", async () => {
      const { run } = setup({}, { trainFound: false, trainDocument: {} });
      const plan = await run();
      expect(plan.problems).toHaveLength(6);
      expect(plan.problems[0]).toMatch(
        /the release train 2026\.11\.19 has not been created/,
      );
    });

    it("says that a release branch does not exist", async () => {
      const { run } = setup(
        {},
        {},
        {
          oss: [milestone("7.0.5"), milestone("7.1.1"), milestone("7.2.0-M3")],
        },
      );
      const plan = await run();
      expect(plan.problems).toEqual([
        expect.stringMatching(
          /release\/7\.2\.0-M3 does not exist in the commercial repository: it is built from embargoed\/frozen\/main/,
        ),
      ]);
    });

    it("says that a .0 version has no open milestone", async () => {
      const { run } = setup(
        {},
        { ossBranches: ["main"], ltsGenerations: [] },
        { oss: [milestone("7.2.0-M1", "closed")] },
      );
      const plan = await run();
      expect(plan.problems).toEqual([
        expect.stringMatching(
          /main \(7\.2\.0-SNAPSHOT\) has no open milestone in spring-projects\/spring-security/,
        ),
      ]);
    });

    it("says that the three branches of a generation have different versions", async () => {
      const { fixture, run } = setup(
        {},
        { ossBranches: ["7.0.x"], ltsGenerations: [] },
      );
      git(fixture.seed, "switch", "-q", "embargoed/frozen/7.0.x");
      const fs = await import("node:fs");
      fs.writeFileSync(
        `${fixture.seed}/gradle.properties`,
        "version=7.0.4-SNAPSHOT\n",
      );
      git(fixture.seed, "commit", "-q", "-am", "Another version");
      git(fixture.seed, "push", "-q", "commercial", "embargoed/frozen/7.0.x");
      git(fixture.work, "fetch", "-q", "origin");
      const plan = await run();
      expect(plan.problems).toEqual([
        expect.stringMatching(
          /must have one version, and have 7\.0\.5-SNAPSHOT \(7\.0\.x\), 7\.0\.4-SNAPSHOT \(embargoed\/frozen\/7\.0\.x\)/,
        ),
      ]);
    });

    it("says that a branch does not exist, in the repository that should have it", async () => {
      const { run } = setup(
        {},
        { ossBranches: ["7.0.x", "7.9.x"], ltsGenerations: ["6.9.x"] },
      );
      const plan = await run();
      expect(plan.problems).toEqual(
        expect.arrayContaining([
          "7.9.x does not exist in spring-projects/spring-security",
          "embargoed/frozen/7.9.x does not exist in the commercial repository",
          "embargoed/active/7.9.x does not exist in the commercial repository",
          "embargoed/lts/6.9.x does not exist in the commercial repository",
        ]),
      );
    });

    it("lists every problem at once", async () => {
      const { run } = setup(
        {},
        {
          trainDocument: train({
            "7.1.1": {},
            "6.5.11": {},
          }),
        },
      );
      const plan = await run();
      expect(plan.problems).toHaveLength(2);
      expect(describeProblems(plan.problems)).toMatch(/2 problems:\n- .*\n- /);
    });

    it("refuses a repository that is not commercial, before it fetches anything", async () => {
      const { fixture, run } = setup(
        {},
        { hostRepository: "spring-projects/spring-security" },
      );
      await expect(run()).rejects.toThrow(/name ends with -commercial/);
      expect(git(fixture.work, "remote")).toBe("origin");
    });

    it("refuses an OSS repository that is the host", async () => {
      const { run } = setup(
        {},
        { ossRepository: "spring-projects/spring-security-commercial" },
      );
      await expect(run()).rejects.toThrow(
        /is the repository that runs the freeze/,
      );
    });
  });
});
