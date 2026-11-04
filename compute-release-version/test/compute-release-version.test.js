import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  candidateOf,
  noTrainSummary,
  releaseTrainOf,
  run,
} from "../src/index.js";
import { createOctokit } from "../src/octokit.js";
import { defaultMilestones, startFakeGitHub } from "./support/fake-github.js";
import { runAction } from "./support/run-action.js";

const fixture = JSON.parse(fs.readFileSync(defaultMilestones, "utf8"));
const REPO = "tutorial/spring-merge";

describe("candidateOf", () => {
  it("removes -SNAPSHOT", () => {
    expect(candidateOf("7.0.1-SNAPSHOT")).toBe("7.0.1");
    expect(candidateOf("7.1.0-SNAPSHOT")).toBe("7.1.0");
    expect(candidateOf("7.0.1.1-SNAPSHOT")).toBe("7.0.1.1");
  });

  it.each([
    "7.0.1",
    "7.1.0-M1",
    "7.1.0-RC1",
    "7.1.0-M1-SNAPSHOT",
    "7.1-SNAPSHOT",
    "x-SNAPSHOT",
    "",
  ])("rejects %j", (version) => {
    expect(() => candidateOf(version)).toThrow();
  });
});

describe("releaseTrainOf", () => {
  it.each([
    [undefined, ""],
    [null, ""],
    ["", ""],
    ["Nothing about a train", ""],
    ["Release Train: 2026.10.22", "2026.10.22"],
    ["Text\nrelease train:2026.10.22\nText", "2026.10.22"],
    ["  RELEASE   TRAIN :   2026.10.22  \r\nMore", "2026.10.22"],
    ["Release Train: 2026.10.22\nRelease Train: 2026.10.22", "2026.10.22"],
    ["The Release Train: 2026.10.22 is it", ""],
  ])("reads %j as %j", (description, expected) => {
    expect(releaseTrainOf(description)).toBe(expected);
  });

  it.each(["soon", "2026-10-22", "2026.10", ""])(
    "does not take the name %j",
    (name) => {
      expect(() => releaseTrainOf(`Release Train: ${name}`, "5.8.30")).toThrow(
        "The description of 5.8.30 names the release train",
      );
    },
  );

  it("fails for two different trains", () => {
    expect(() =>
      releaseTrainOf("Release Train: 2026.10.22\nRelease Train: 2026.11.19"),
    ).toThrow("names two release trains (2026.10.22, 2026.11.19)");
  });
});

describe("run", () => {
  let fake;
  const octokit = (options = {}) =>
    createOctokit({ baseUrl: fake.url, ...options });
  const release = (snapshotVersion, options = {}) =>
    run(
      { snapshotVersion, milestoneRepository: REPO, ...options },
      { octokit: octokit() },
    );

  beforeAll(async () => {
    fake = await startFakeGitHub();
  });
  afterAll(() => fake.close());

  describe("a version that does not end with .0", () => {
    it("is released as itself, on the due date of its milestone", async () => {
      expect(await release("7.0.1-SNAPSHOT")).toMatchObject({
        found: true,
        releaseVersion: "7.0.1",
        dueDate: "2026-11-19",
      });
    });

    it("releases a hotfix as itself", async () => {
      expect(await release("7.0.1.1-SNAPSHOT")).toMatchObject({
        found: true,
        releaseVersion: "7.0.1.1",
        dueDate: "2026-11-19",
      });
    });

    it("finds a closed milestone", async () => {
      expect(await release("6.5.5-SNAPSHOT")).toMatchObject({
        found: true,
        releaseVersion: "6.5.5",
        dueDate: "2026-08-01",
      });
    });

    it("reports that there is no milestone", async () => {
      expect(await release("7.0.9-SNAPSHOT")).toEqual({
        found: false,
        candidate: "7.0.9",
        message: `${REPO} has no milestone 7.0.9, so nothing is built`,
      });
    });

    it("does not match a longer version", async () => {
      // 7.0.1 must not be found as 7.0.1.1, nor 7.1.0 as 7.1.01
      expect(await release("7.0.11-SNAPSHOT")).toMatchObject({
        found: false,
        message: expect.stringContaining("has no milestone 7.0.11"),
      });
    });
  });

  describe("a version that ends with .0", () => {
    it("is released as the open milestone with the earliest due date", async () => {
      // 7.1.0-RC1 is due before 7.1.0. 7.1.0-M3 is closed, and 7.1.01 and 7.1.0.1 are other versions
      expect(await release("7.1.0-SNAPSHOT")).toMatchObject({
        found: true,
        releaseVersion: "7.1.0-RC1",
        dueDate: "2026-11-19",
      });
    });

    it("is released as the version itself when its milestones are closed", async () => {
      const milestones = fixture.map((m) =>
        m.title === "7.1.0-RC1" ? { ...m, state: "closed" } : m,
      );
      const other = await startFakeGitHub({ milestones });
      try {
        const result = await run(
          { snapshotVersion: "7.1.0-SNAPSHOT", milestoneRepository: REPO },
          { octokit: createOctokit({ baseUrl: other.url }) },
        );
        expect(result).toMatchObject({
          found: true,
          releaseVersion: "7.1.0",
          dueDate: "2026-12-17",
        });
      } finally {
        await other.close();
      }
    });

    describe("release-only, for a hotfix", () => {
      it("does not find a version whose next release is a release candidate", async () => {
        expect(
          await release("7.1.0-SNAPSHOT", { releaseOnly: true }),
        ).toMatchObject({
          found: false,
          message: expect.stringContaining(
            `The next release of 7.1.0 in ${REPO} is 7.1.0-RC1, and not 7.1.0`,
          ),
        });
      });

      it("finds the version whose next release is the version itself", async () => {
        const milestones = fixture.map((m) =>
          m.title === "7.1.0-RC1" ? { ...m, state: "closed" } : m,
        );
        const other = await startFakeGitHub({ milestones });
        try {
          const result = await run(
            {
              snapshotVersion: "7.1.0-SNAPSHOT",
              milestoneRepository: REPO,
              releaseOnly: true,
            },
            { octokit: createOctokit({ baseUrl: other.url }) },
          );
          expect(result).toMatchObject({
            found: true,
            releaseVersion: "7.1.0",
          });
        } finally {
          await other.close();
        }
      });

      it("changes nothing for a version that does not end with .0", async () => {
        expect(
          await release("7.0.1-SNAPSHOT", { releaseOnly: true }),
        ).toMatchObject({ found: true, releaseVersion: "7.0.1" });
      });
    });

    it("goes by the due date and not by the name", async () => {
      // 7.3.0-RC1 is due before 7.3.0-M1
      expect(await release("7.3.0-SNAPSHOT")).toMatchObject({
        found: true,
        releaseVersion: "7.3.0-RC1",
        dueDate: "2027-02-01",
      });
    });

    // Due on the same day, the order is: milestones, release candidates, the version.
    it.each([
      [
        ["8.0.0", "8.0.0-RC2", "8.0.0-RC1", "8.0.0-M10", "8.0.0-M2"],
        "8.0.0-M2",
      ],
      [["8.0.0", "8.0.0-RC2", "8.0.0-RC1", "8.0.0-M10"], "8.0.0-M10"],
      [["8.0.0", "8.0.0-RC2", "8.0.0-RC1"], "8.0.0-RC1"],
      [["8.0.0", "8.0.0-RC2"], "8.0.0-RC2"],
      [["8.0.0"], "8.0.0"],
    ])(
      "orders the milestones of one day: %j is released as %s",
      async (titles, expected) => {
        const day = "2027-01-01T12:00:00Z";
        const other = await startFakeGitHub({
          milestones: titles.map((title, i) => ({
            number: i,
            title,
            state: "open",
            due_on: day,
          })),
        });
        try {
          const result = await run(
            { snapshotVersion: "8.0.0-SNAPSHOT", milestoneRepository: REPO },
            { octokit: createOctokit({ baseUrl: other.url }) },
          );
          expect(result.releaseVersion).toBe(expected);
        } finally {
          await other.close();
        }
      },
    );

    it("reports that no milestone is open", async () => {
      expect(await release("7.7.0-SNAPSHOT")).toMatchObject({
        found: false,
        message: expect.stringContaining(
          `${REPO} has no open milestone for 7.7.0`,
        ),
      });
    });

    it("does not take the milestones of another version", async () => {
      expect(await release("7.0.0-SNAPSHOT")).toMatchObject({
        found: false,
        message: expect.stringContaining("has no open milestone for 7.0.0"),
      });
    });
  });

  describe("the release train", () => {
    it("is the one that the description names, whatever the due date", async () => {
      expect(await release("5.8.30-SNAPSHOT")).toMatchObject({
        found: true,
        releaseVersion: "5.8.30",
        dueDate: "2026-11-19",
        releaseTrain: "2026.10.22",
      });
    });

    it("is empty if the description names none", async () => {
      for (const version of ["5.8.31", "5.8.34", "7.0.1.1"]) {
        expect(await release(`${version}-SNAPSHOT`)).toMatchObject({
          found: true,
          releaseTrain: "",
        });
      }
    });

    it("fails if it is required and the description names none", async () => {
      await expect(
        release("5.8.31-SNAPSHOT", { requireReleaseTrain: true }),
      ).rejects.toThrow(
        'The description of the milestone 5.8.31 of tutorial/spring-merge does not name its release train: add a line "Release Train: <name>"',
      );
    });

    it("is not asked for if it is required and the description names it", async () => {
      expect(
        await release("5.8.30-SNAPSHOT", { requireReleaseTrain: true }),
      ).toMatchObject({ releaseTrain: "2026.10.22" });
    });

    it("fails for a name that is not a train, and for two trains", async () => {
      await expect(release("5.8.33-SNAPSHOT")).rejects.toThrow(
        'names the release train "soon"',
      );
      await expect(release("5.8.32-SNAPSHOT")).rejects.toThrow(
        "names two release trains",
      );
    });
  });

  describe("the due date", () => {
    it("fails if the milestone has none", async () => {
      await expect(release("7.2.0-SNAPSHOT")).rejects.toThrow(
        "7.2.0-M1 of tutorial/spring-merge has no due date",
      );
    });

    it("is empty if it has none and it is not required", async () => {
      expect(
        await release("7.2.0-SNAPSHOT", { requireDueDate: false }),
      ).toMatchObject({
        found: true,
        releaseVersion: "7.2.0-M1",
        dueDate: "",
      });
    });

    it("is the date in UTC, late in the day too", async () => {
      expect(await release("7.5.0-SNAPSHOT")).toMatchObject({
        found: true,
        releaseVersion: "7.5.0-M1",
        dueDate: "2027-06-01",
      });
    });
  });

  describe("the requests", () => {
    it("send the token", async () => {
      fake.requests.length = 0;
      await run(
        { snapshotVersion: "7.0.1-SNAPSHOT", milestoneRepository: REPO },
        { octokit: octokit({ token: "the-token" }) },
      );
      // Octokit sends a token the way GitHub's own documentation does
      expect(fake.requests[0].headers.authorization).toBe("token the-token");
    });

    it("send no token if there is none", async () => {
      fake.requests.length = 0;
      await release("7.0.1-SNAPSHOT");
      expect(fake.requests[0].headers.authorization).toBeUndefined();
    });

    it("read every page of milestones", async () => {
      const many = Array.from({ length: 250 }, (_, i) => ({
        number: i,
        title: `1.0.${i + 1}`,
        state: "open",
        due_on: "2027-01-01T12:00:00Z",
      }));
      const other = await startFakeGitHub({ milestones: many });
      try {
        const result = await run(
          { snapshotVersion: "1.0.230-SNAPSHOT", milestoneRepository: REPO },
          { octokit: createOctokit({ baseUrl: other.url }) },
        );
        expect(result.releaseVersion).toBe("1.0.230");
        expect(other.requests).toHaveLength(3);
      } finally {
        await other.close();
      }
    });

    it("report a repository that is not found", async () => {
      await expect(
        release("7.0.1-SNAPSHOT", { milestoneRepository: "missing/missing" }),
      ).rejects.toThrow(/failed with 404.*cannot read it/);
    });
  });
});

describe("noTrainSummary", () => {
  const server = "https://github.com";

  describe("frozen (an OSS milestone)", () => {
    it("links to create a milestone that does not exist, and asks for the date of a train", () => {
      expect(
        noTrainSummary({
          candidate: "7.0.1",
          repository: "acme/widgets",
          kind: "frozen",
        }),
      ).toBe(
        [
          "### 7.0.1 is not in a release train",
          "",
          "acme/widgets has no milestone 7.0.1.",
          "",
          "To add it to a release train:",
          `1. [create the milestone 7.0.1](${server}/acme/widgets/milestones/new) in acme/widgets.`,
          "2. Set its due date to the date of a release train (for example 2026-11-19).",
          "3. Run the workflow again.",
          "",
        ].join("\n"),
      );
    });

    it("is the default kind", () => {
      expect(
        noTrainSummary({ candidate: "7.0.1", repository: "acme/widgets" }),
      ).toBe(
        noTrainSummary({
          candidate: "7.0.1",
          repository: "acme/widgets",
          kind: "frozen",
        }),
      );
    });

    it("links to set the due date of a milestone that has none", () => {
      expect(
        noTrainSummary({
          candidate: "7.0.1",
          repository: "acme/widgets",
          milestone: { html_url: `${server}/acme/widgets/milestone/12` },
          kind: "frozen",
        }),
      ).toBe(
        [
          "### 7.0.1 is not in a release train",
          "",
          "The milestone 7.0.1 of acme/widgets has no due date.",
          "",
          "To add it to a release train:",
          `1. [Set its due date](${server}/acme/widgets/milestone/12/edit) to the date of a release train (for example 2026-11-19).`,
          "2. Run the workflow again.",
          "",
        ].join("\n"),
      );
    });

    it("does not mention the release train line", () => {
      expect(
        noTrainSummary({ candidate: "7.0.1", repository: "acme/widgets" }),
      ).not.toContain("Release Train:");
    });
  });

  describe("lts (a commercial milestone)", () => {
    it("asks for the release train line of the description, and not for a due date", () => {
      const summary = noTrainSummary({
        candidate: "6.5.12",
        repository: "acme/widgets-commercial",
        kind: "lts",
      });
      expect(summary).toBe(
        [
          "### 6.5.12 is not in a release train",
          "",
          "acme/widgets-commercial has no milestone 6.5.12.",
          "",
          "To add it to a release train:",
          `1. [create the milestone 6.5.12](${server}/acme/widgets-commercial/milestones/new) in acme/widgets-commercial, and add a line \`Release Train: 2026.11.19\` to its description. The workflow sets its due date from the train.`,
          "2. Run the workflow again.",
          "",
        ].join("\n"),
      );
      expect(summary).not.toContain("hotfix");
    });

    it("links to edit the description of a milestone that does not name its train", () => {
      const summary = noTrainSummary({
        candidate: "6.5.12",
        repository: "acme/widgets-commercial",
        milestone: {
          html_url: `${server}/acme/widgets-commercial/milestone/3`,
        },
        kind: "lts",
      });
      expect(summary).toContain(
        "The description of the milestone 6.5.12 of acme/widgets-commercial does not name its release train.",
      );
      expect(summary).toContain(
        `[Edit the milestone](${server}/acme/widgets-commercial/milestone/3/edit) and add a line \`Release Train: 2026.11.19\``,
      );
      expect(summary).not.toContain("due date to");
    });
  });

  describe("active (a hotfix)", () => {
    it("asks for the milestone of the hotfix in the commercial repository, with any due date", () => {
      const summary = noTrainSummary({
        candidate: "7.0.1.1",
        repository: "acme/widgets-commercial",
        kind: "active",
      });
      expect(summary).toBe(
        [
          "### 7.0.1.1 is not in a release train",
          "",
          "acme/widgets-commercial has no milestone 7.0.1.1.",
          "",
          "The hotfix 7.0.1.1 is in the release train of the OSS version 7.0.1: the train in which the milestone 7.0.1 of the OSS repository is due.",
          "",
          "To add it to a release train:",
          `1. [create the milestone 7.0.1.1](${server}/acme/widgets-commercial/milestones/new) in acme/widgets-commercial. Any due date will do, because the workflow sets it to the commercial general availability of the train (for example 2026-12-24).`,
          "2. Run the workflow again.",
          "",
        ].join("\n"),
      );
      expect(summary).not.toContain("Release Train:");
    });

    it("asks for the date of a train on the OSS milestone that the hotfix fixes", () => {
      const summary = noTrainSummary({
        candidate: "7.0.1",
        repository: "acme/widgets",
        kind: "active",
      });
      expect(summary).toContain("acme/widgets has no milestone 7.0.1.");
      expect(summary).toContain(
        "A hotfix of 7.0.1 is in the release train in which the milestone 7.0.1 is due.",
      );
      expect(summary).toContain(
        `1. [create the milestone 7.0.1](${server}/acme/widgets/milestones/new) in acme/widgets.`,
      );
      expect(summary).toContain(
        "2. Set its due date to the date of a release train (for example 2026-11-19).",
      );
      expect(summary).not.toContain("Release Train:");
    });

    it("links to set the due date of the OSS milestone that has none", () => {
      const summary = noTrainSummary({
        candidate: "7.0.1",
        repository: "acme/widgets",
        milestone: { html_url: `${server}/acme/widgets/milestone/12` },
        kind: "active",
      });
      expect(summary).toContain(
        "The milestone 7.0.1 of acme/widgets has no due date.",
      );
      expect(summary).toContain(
        `[Set its due date](${server}/acme/widgets/milestone/12/edit) to the date of a release train`,
      );
    });
  });

  it("rejects a kind that it does not know", () => {
    expect(() =>
      noTrainSummary({ candidate: "7.0.1", repository: "a/b", kind: "x" }),
    ).toThrow(/Unknown kind "x"/);
  });
});

// The actions run as programs: the sources, and the bundle that GitHub runs (dist/).
describe.each([["src/index.js"], ["dist/index.js"]])(
  "the program %s",
  (entry) => {
    let fake;
    beforeAll(async () => {
      fake = await startFakeGitHub();
    });
    afterAll(() => fake.close());

    const inputs = (snapshotVersion, more = {}) => ({
      "snapshot-version": snapshotVersion,
      "milestone-repository": REPO,
      ...more,
    });

    it("writes its outputs", async () => {
      const result = await runAction(entry, inputs("7.1.0-SNAPSHOT"), {
        GITHUB_API_URL: fake.url,
      });
      expect(result.code).toBe(0);
      expect(result.outputs).toEqual({
        found: "true",
        "release-version": "7.1.0-RC1",
        "due-date": "2026-11-19",
        "release-train": "",
        "milestone-url": `https://github.com/${REPO}/milestone/8`,
      });
    });

    it("writes the release train that the description names, and requires it when told to", async () => {
      const named = await runAction(entry, inputs("5.8.30-SNAPSHOT"), {
        GITHUB_API_URL: fake.url,
      });
      expect(named.code).toBe(0);
      expect(named.outputs["release-train"]).toBe("2026.10.22");
      const missing = await runAction(
        entry,
        inputs("5.8.31-SNAPSHOT", { "require-release-train": "true" }),
        { GITHUB_API_URL: fake.url },
      );
      expect(missing.code).toBe(1);
      expect(missing.stdout).toContain("does not name its release train");
    });

    it("allows a missing due date when told to", async () => {
      const result = await runAction(
        entry,
        inputs("7.2.0-SNAPSHOT", { "require-due-date": "false" }),
        {
          GITHUB_API_URL: fake.url,
        },
      );
      expect(result.code).toBe(0);
      expect(result.outputs).toEqual({
        found: "true",
        "release-version": "7.2.0-M1",
        "due-date": "",
        "release-train": "",
        "milestone-url": `https://github.com/${REPO}/milestone/12`,
      });
    });

    it("says in the summary how to add the version to a train", async () => {
      const summary = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), "summary-")),
        "summary.md",
      );
      for (const [version, expected] of [
        ["7.0.9-SNAPSHOT", "[create the milestone 7.0.9]"],
        ["7.2.0-SNAPSHOT", "[Set its due date]"],
      ]) {
        await runAction(entry, inputs(version), {
          GITHUB_API_URL: fake.url,
          GITHUB_STEP_SUMMARY: summary,
        });
        expect(fs.readFileSync(summary, "utf8")).toContain(expected);
      }
    });

    it("says in the summary what the kind of the branch needs", async () => {
      const summary = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), "summary-")),
        "summary.md",
      );
      await runAction(entry, inputs("7.0.9-SNAPSHOT", { kind: "lts" }), {
        GITHUB_API_URL: fake.url,
        GITHUB_STEP_SUMMARY: summary,
      });
      const text = fs.readFileSync(summary, "utf8");
      expect(text).toContain("`Release Train: 2026.11.19`");
      expect(text).not.toContain("Set its due date");
    });

    it("ends with the notice No release, and not an error, for a release that is not the next one", async () => {
      const result = await runAction(
        entry,
        inputs("7.1.0-SNAPSHOT", { "release-only": "true" }),
        { GITHUB_API_URL: fake.url },
      );
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("::notice title=No release::");
      expect(result.outputs.found).toBe("false");
    });

    it("fails with an error that GitHub shows", async () => {
      const result = await runAction(entry, inputs("7.2.0-SNAPSHOT"), {
        GITHUB_API_URL: fake.url,
      });
      expect(result.code).toBe(1);
      expect(result.stdout).toContain(
        "::error::The milestone 7.2.0-M1 of tutorial/spring-merge has no due date",
      );
      expect(result.outputs).toEqual({});
    });

    it("fails if the milestone does not exist", async () => {
      const result = await runAction(entry, inputs("7.0.9-SNAPSHOT"), {
        GITHUB_API_URL: fake.url,
      });
      expect(result.code).toBe(1);
      expect(result.stdout).toContain(
        "::error::tutorial/spring-merge has no milestone 7.0.9",
      );
      expect(result.outputs).toEqual({});
    });

    it("fails if there is no open milestone for a .0 version", async () => {
      const result = await runAction(entry, inputs("7.7.0-SNAPSHOT"), {
        GITHUB_API_URL: fake.url,
      });
      expect(result.code).toBe(1);
      expect(result.stdout).toContain(
        "::error::tutorial/spring-merge has no open milestone for 7.7.0",
      );
    });

    it.each([
      ["7.0.9-SNAPSHOT", "tutorial/spring-merge has no milestone 7.0.9"],
      [
        "7.7.0-SNAPSHOT",
        "tutorial/spring-merge has no open milestone for 7.7.0",
      ],
    ])(
      "ends with a notice for %s if told not to fail",
      async (version, message) => {
        const result = await runAction(
          entry,
          inputs(version, { "fail-if-missing": "false" }),
          { GITHUB_API_URL: fake.url },
        );
        expect(result.code).toBe(0);
        expect(result.stdout).toContain(
          `::notice title=No milestone::${message}`,
        );
        expect(result.stdout).toContain("so nothing is built");
        expect(result.outputs).toEqual({
          found: "false",
          "release-version": "",
          "release-train": "",
          "due-date": "",
          "milestone-url": "",
        });
      },
    );

    it("still fails without a due date if told not to fail if missing", async () => {
      const result = await runAction(
        entry,
        inputs("7.2.0-SNAPSHOT", { "fail-if-missing": "false" }),
        { GITHUB_API_URL: fake.url },
      );
      expect(result.code).toBe(1);
      expect(result.stdout).toContain("::error::The milestone 7.2.0-M1");
    });

    it("fails if an input is wrong", async () => {
      const result = await runAction(
        entry,
        inputs("7.1.0-SNAPSHOT", { "require-due-date": "maybe" }),
        {
          GITHUB_API_URL: fake.url,
        },
      );
      expect(result.code).toBe(1);
      expect(result.stdout).toContain("must be true or false");
    });
  },
);
