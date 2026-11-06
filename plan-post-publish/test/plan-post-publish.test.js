import { describe, expect, it } from "vitest";
import { candidatesOf, plan, summaryOf } from "../src/index.js";

const oss = "spring-projects/spring-security";
const commercial = "spring-projects/spring-security-commercial";
const today = "2026-11-05";

// what the Spring projects API says: 5.7.x to 6.5.x are commercial, 7.0.x to 7.2.x are OSS
const generation = (name, ossEnd, commercialEnd) => ({
  name,
  ossSupportEndDate: ossEnd,
  commercialSupportEndDate: commercialEnd,
});
const GENERATIONS = [
  generation("5.7.x", "2022-11-01", "2027-12-31"),
  generation("5.8.x", "2023-11-01", "2027-12-31"),
  generation("6.4.x", "2026-01-01", "2027-12-31"),
  generation("6.5.x", "2026-06-01", "2028-12-31"),
  generation("7.0.x", "2027-06-30", "2029-06-30"),
  generation("7.1.x", "2027-12-31", "2029-12-31"),
  generation("7.2.x", "2028-06-30", "2030-06-30"),
  generation("4.0.x", "2018-01-01", "2020-01-01"), // not supported any more
];

const fakeFetch =
  (generations = GENERATIONS) =>
  async () => ({
    ok: true,
    json: async () => ({ _embedded: { generations } }),
  });

const notFound = () => Object.assign(new Error("Not Found"), { status: 404 });

/**
 * A fake of GitHub that only reads: the milestones, the tags and the branches of the two
 * repositories (a branch is its `version=` in gradle.properties, or true if it has none). It
 * has no way to write, so a plan that tried would fail.
 */
function fakeOctokit({
  ossMilestones = [],
  commercialMilestones = [],
  ossTags = [],
  commercialTags = [],
  ossBranches = {},
  commercialBranches = {},
} = {}) {
  const milestones = {
    "spring-security": ossMilestones,
    "spring-security-commercial": commercialMilestones,
  };
  const tags = {
    "spring-security": ossTags,
    "spring-security-commercial": commercialTags,
  };
  const branches = {
    "spring-security": ossBranches,
    "spring-security-commercial": commercialBranches,
  };
  return {
    paginate: async (method, params) => method(params),
    rest: {
      issues: {
        listMilestones: ({ repo }) =>
          milestones[repo].map(([title, number]) => ({
            title,
            number,
            state: "open",
          })),
      },
      git: {
        getRef: async ({ repo, ref }) => {
          if (!tags[repo].includes(ref.replace("tags/", ""))) {
            throw notFound();
          }
          return { data: {} };
        },
      },
      repos: {
        getBranch: async ({ repo, branch }) => {
          if (!(branch in branches[repo])) {
            throw notFound();
          }
          return { data: {} };
        },
        getContent: async ({ repo, ref }) => {
          const version = branches[repo][ref];
          if (typeof version !== "string") {
            throw notFound();
          }
          return {
            data: {
              content: Buffer.from(
                `group=org.example\nversion=${version}\n`,
              ).toString("base64"),
            },
          };
        },
      },
    },
  };
}

const versions = (tag) => {
  const [, major, minor, patch, hotfix] =
    /^(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?/.exec(tag);
  return {
    releaseVersion: tag,
    baseVersion: tag.replace(/-(M|RC)\d+$/, ""),
    generation: `${major}.${minor}.x`,
    hotfix: hotfix !== undefined && patch !== undefined,
  };
};
const common = {
  ossRepository: oss,
  commercialRepository: commercial,
  project: "spring-security",
  today,
};
const frozenAndActive = (...names) =>
  Object.fromEntries(
    names.flatMap((n) => [
      [`embargoed/frozen/${n}`, true],
      [`embargoed/active/${n}`, true],
    ]),
  );
const OSS_BRANCHES = {
  "7.0.x": "7.0.9-SNAPSHOT",
  "7.1.x": "7.1.3-SNAPSHOT",
  main: "7.2.0-SNAPSHOT",
};
const LTS_BRANCHES = {
  "embargoed/lts/5.7.x": "5.7.28-SNAPSHOT",
  "embargoed/lts/5.8.x": "5.8.30-SNAPSHOT",
  "embargoed/lts/6.4.x": "6.4.21-SNAPSHOT",
  "embargoed/lts/6.5.x": "6.5.14-SNAPSHOT",
};
const everything = (overrides = {}) =>
  fakeOctokit({
    ossMilestones: [
      ["7.0.9", 434],
      ["7.1.3", 435],
      ["7.2.0", 436],
    ],
    commercialMilestones: [
      ["7.0.9", 95],
      ["7.1.3", 94],
      ["7.2.0", 93],
      ["7.0.9.1", 87],
      ["5.8.30", 90],
      ["6.5.14", 92],
    ],
    ossTags: ["7.0.9", "7.1.3", "7.2.0"],
    commercialTags: ["5.8.30", "6.5.14"],
    ossBranches: OSS_BRANCHES,
    commercialBranches: {
      ...frozenAndActive("7.0.x", "7.1.x", "main"),
      ...LTS_BRANCHES,
    },
    ...overrides,
  });
const run = (tag, octokit = everything(), extra = {}) =>
  plan(
    { ...versions(tag), ...common, ...extra },
    { octokit, fetch: fakeFetch() },
  );

describe("an OSS release", () => {
  it("is copied, merged forward through the OSS branches, and its branches are deleted", async () => {
    const { plan: result, notices } = await run("7.1.3");
    expect(result).toMatchObject({
      tag: "7.1.3",
      kind: "oss",
      copy: true,
      snapshotVersion: "7.1.3-INTERNAL-SNAPSHOT",
      deleteBranches: ["release/7.1.3", "embargoed/7.1.3-INTERNAL-SNAPSHOT"],
      milestones: {
        oss: { number: 435 },
        commercial: { number: 94 },
      },
    });
    expect(result.merge).toEqual({
      kind: "oss",
      tagRepository: oss,
      branches: [
        {
          generation: "7.1.x",
          branch: "7.1.x",
          frozen: "embargoed/frozen/7.1.x",
          active: "embargoed/active/7.1.x",
        },
        {
          generation: "7.2.x",
          branch: "main",
          frozen: "embargoed/frozen/main",
          active: "embargoed/active/main",
        },
      ],
    });
    expect(notices).toEqual([]);
  });

  it("is merged from the oldest generation of the tag to the newest", async () => {
    const { plan: result } = await run("7.0.9");
    expect(result.merge.branches.map((b) => b.branch)).toEqual([
      "7.0.x",
      "7.1.x",
      "main",
    ]);
  });

  it("is only merged into main for the newest generation", async () => {
    const { plan: result } = await run("7.2.0");
    expect(result.merge.branches.map((b) => b.branch)).toEqual(["main"]);
  });

  it("does not copy, and warns, if the commercial repository has no milestone, but it merges", async () => {
    const octokit = everything({
      commercialMilestones: [["7.1.3.1", 86]],
    });
    const { plan: result, notices } = await run("7.1.3", octokit);
    expect(result.kind).toBe("oss");
    expect(result.copy).toBe(false);
    expect(result.merge.branches).toHaveLength(2);
    expect(notices).toEqual([
      {
        level: "warning",
        title: "No commercial milestone",
        message: expect.stringContaining(`${commercial} has none`),
      },
    ]);
  });

  it("fails before anything, naming the repository, if the tag does not exist in OSS", async () => {
    const octokit = everything({ ossTags: [] });
    await expect(run("7.1.3", octokit)).rejects.toThrow(
      `${oss} has no tag 7.1.3`,
    );
  });

  it("is not for a commercial tag: a tag that only the commercial repository has is not found in OSS", async () => {
    const octokit = everything({ ossTags: [], commercialTags: ["7.1.3"] });
    await expect(run("7.1.3", octokit)).rejects.toThrow("no tag 7.1.3");
  });

  it("fails with every branch that is missing", async () => {
    const octokit = everything({
      commercialBranches: {
        ...frozenAndActive("7.1.x"),
        "embargoed/active/main": true,
      },
    });
    const error = await run("7.1.3", octokit).catch((e) => e);
    expect(error.title).toBe("Branches missing");
    expect(error.message).toContain(
      `${commercial} has no branch embargoed/frozen/main`,
    );
    expect(error.message).not.toContain("embargoed/frozen/7.1.x");
  });
});

describe("a hotfix", () => {
  it("is not merged, and not copied, and says so as information", async () => {
    const { plan: result, notices } = await run("7.0.9.1");
    expect(result).toMatchObject({
      kind: "hotfix",
      copy: false,
      merge: null,
      snapshotVersion: "7.0.9.1-SNAPSHOT",
      deleteBranches: ["release/7.0.9.1", "embargoed/7.0.9.1-SNAPSHOT"],
    });
    expect(notices.map((n) => n.level)).toEqual(["info"]);
  });

  it("needs no tag", async () => {
    const octokit = everything({ commercialTags: [], ossTags: [] });
    const { plan: result } = await run("7.0.9.1", octokit);
    expect(result.merge).toBeNull();
  });
});

describe("a long-term support release", () => {
  it("is merged through the long-term support branches only, from its own", async () => {
    const { plan: result, notices } = await run("5.8.30");
    expect(result).toMatchObject({
      kind: "lts",
      copy: false,
      snapshotVersion: "5.8.30-SNAPSHOT",
      deleteBranches: ["release/5.8.30", "embargoed/5.8.30-SNAPSHOT"],
    });
    expect(result.merge).toEqual({
      kind: "lts",
      tagRepository: commercial,
      branches: [
        { generation: "5.8.x", branch: "embargoed/lts/5.8.x" },
        { generation: "6.4.x", branch: "embargoed/lts/6.4.x" },
        { generation: "6.5.x", branch: "embargoed/lts/6.5.x" },
      ],
    });
    expect(notices.map((n) => n.level)).toEqual(["info"]);
  });

  it("is only its own branch for the newest", async () => {
    const { plan: result } = await run("6.5.14");
    expect(result.merge.branches.map((b) => b.branch)).toEqual([
      "embargoed/lts/6.5.x",
    ]);
  });

  it("needs its tag in the commercial repository, and never looks in OSS", async () => {
    const octokit = everything({ commercialTags: [], ossTags: ["5.8.30"] });
    await expect(run("5.8.30", octokit)).rejects.toThrow(
      `${commercial} has no tag 5.8.30`,
    );
  });

  it("warns that neither repository has a milestone", async () => {
    const octokit = everything({
      commercialMilestones: [],
      commercialTags: ["5.8.30"],
    });
    const { plan: result, notices } = await run("5.8.30", octokit);
    expect(result.copy).toBe(false);
    expect(notices).toEqual([
      {
        level: "warning",
        title: "No milestone",
        message: expect.stringContaining("neither"),
      },
    ]);
  });
});

describe("the branch of the tag, when no generation is named after it", () => {
  const session = (generations, versions) => ({
    fetch: fakeFetch(generations),
    octokit: fakeOctokit({
      commercialMilestones: [["2021.2.9", 29]],
      commercialTags: ["2021.2.9"],
      commercialBranches: versions,
    }),
  });
  const SESSION_GENERATIONS = [
    generation("2.7.x", "2023-01-01", "2027-12-31"),
    generation("3.4.x", "2025-01-01", "2027-12-31"),
    generation("3.5.x", "2026-01-01", "2028-12-31"),
  ];

  it("is the one whose gradle.properties has the version of the tag, for long-term support too", async () => {
    const { fetch, octokit } = session(SESSION_GENERATIONS, {
      "embargoed/lts/2.7.x": "2021.2.9-SNAPSHOT",
      "embargoed/lts/3.4.x": "3.4.11-SNAPSHOT",
      "embargoed/lts/3.5.x": "3.5.9-SNAPSHOT",
    });
    const { plan: result } = await plan(
      { ...versions("2021.2.9"), ...common, project: "spring-session" },
      { octokit, fetch },
    );
    expect(result.merge.branches.map((b) => b.branch)).toEqual([
      "embargoed/lts/2.7.x",
      "embargoed/lts/3.4.x",
      "embargoed/lts/3.5.x",
    ]);
  });

  it("fails, and says so, when no branch has the version", async () => {
    const { fetch, octokit } = session(SESSION_GENERATIONS, {
      "embargoed/lts/2.7.x": "2.7.1-SNAPSHOT",
      "embargoed/lts/3.4.x": "3.4.11-SNAPSHOT",
      "embargoed/lts/3.5.x": "3.5.9-SNAPSHOT",
    });
    const error = await plan(
      { ...versions("2021.2.9"), ...common },
      { octokit, fetch },
    ).catch((e) => e);
    expect(error.title).toBe("No branch for the tag");
    expect(error.message).toContain("2021.2.x");
    expect(error.message).toContain("nothing was changed");
  });

  it("fails when more than one branch has it", async () => {
    const { fetch, octokit } = session(SESSION_GENERATIONS, {
      "embargoed/lts/2.7.x": "2021.2.9-SNAPSHOT",
      "embargoed/lts/3.4.x": "2021.2.10-SNAPSHOT",
      "embargoed/lts/3.5.x": "3.5.9-SNAPSHOT",
    });
    const error = await plan(
      { ...versions("2021.2.9"), ...common },
      { octokit, fetch },
    ).catch((e) => e);
    expect(error.message).toContain(
      "embargoed/lts/2.7.x (2021.2.9-SNAPSHOT) or embargoed/lts/3.4.x (2021.2.10-SNAPSHOT)",
    );
  });

  it("finds an OSS branch by its version, as main for a generation that the API does not list", async () => {
    const listed = GENERATIONS.filter((g) => g.name !== "7.2.x");
    const octokit = everything();
    const { plan: result } = await plan(
      { ...versions("7.2.0"), ...common },
      { octokit, fetch: fakeFetch(listed) },
    );
    // 7.1.x is the newest the API lists, so its branch is main, which has 7.2.0-SNAPSHOT
    expect(result.merge.branches.map((b) => b.branch)).toEqual(["main"]);
  });

  it("fails for a generation that is not supported any more", async () => {
    const octokit = everything({
      commercialMilestones: [["4.0.5", 1]],
      commercialTags: ["4.0.5"],
    });
    const error = await run("4.0.5", octokit).catch((e) => e);
    expect(error.title).toBe("No branch for the tag");
    expect(error.message).toContain("4.0.x");
  });
});

describe("candidatesOf", () => {
  it("is the OSS branches, or the long-term support ones in embargoed/lts", () => {
    expect(candidatesOf("oss", GENERATIONS, today)).toEqual([
      { generation: "7.0.x", branch: "7.0.x" },
      { generation: "7.1.x", branch: "7.1.x" },
      { generation: "7.2.x", branch: "main" },
    ]);
    expect(
      candidatesOf("lts", GENERATIONS, today).map((c) => c.branch),
    ).toEqual([
      "embargoed/lts/5.7.x",
      "embargoed/lts/5.8.x",
      "embargoed/lts/6.4.x",
      "embargoed/lts/6.5.x",
    ]);
  });
});

describe("the summary", () => {
  it("says the kind, the branches to delete and the merges", async () => {
    const { plan: result } = await run("7.1.3");
    const text = summaryOf(result, true);
    expect(text).toContain("### 7.1.3: Post Publish (dry run)");
    expect(text).toContain(
      `OSS release: the milestone 7.1.3 exists in ${oss} (#435) and in ${commercial} (#94).`,
    );
    expect(text).toContain(
      "Branches to delete: `release/7.1.3`, `embargoed/7.1.3-INTERNAL-SNAPSHOT`",
    );
    expect(text).toContain(
      `The tag \`7.1.3\` of ${oss} is merged into \`7.1.x\`, and forward`,
    );
    expect(text).toContain(
      "| `main` | `embargoed/frozen/main`, `embargoed/active/main` |",
    );
  });

  it("says that a hotfix is not merged, and a real run has no dry run in the title", async () => {
    const { plan: result } = await run("7.0.9.1");
    const text = summaryOf(result, false);
    expect(text).toContain("### 7.0.9.1: Post Publish\n");
    expect(text).toContain("A hotfix is not merged");
  });
});
