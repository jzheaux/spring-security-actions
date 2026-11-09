import { describe, expect, it } from "vitest";
import {
  checkOverride,
  chooseBranches,
  listGenerations,
  parseList,
  readGenerations,
  run,
} from "../src/index.js";
import { runAction } from "./support/run-action.js";

const TODAY = "2026-11-19";

// What api.spring.io says for spring-security: 6.4.x and 6.5.x are commercial, 7.0.x and 7.1.x
// are OSS, 7.2.x is the next one (its branch is main), 5.8.x has no support left.
const generations = [
  {
    name: "5.8.x",
    initialReleaseDate: "2022-11-30",
    ossSupportEndDate: "2023-11-30",
    commercialSupportEndDate: "2026-06-30",
  },
  {
    name: "7.2.x",
    initialReleaseDate: "2026-11-30",
    ossSupportEndDate: "2027-12-31",
    commercialSupportEndDate: "2028-12-31",
  },
  {
    name: "6.4.x",
    initialReleaseDate: "2024-11-30",
    ossSupportEndDate: "2025-12-31",
    commercialSupportEndDate: "2026-12-31",
  },
  {
    name: "7.0.x",
    initialReleaseDate: "2025-11-30",
    ossSupportEndDate: "2026-12-31",
    commercialSupportEndDate: "2027-12-31",
  },
  {
    name: "6.5.x",
    initialReleaseDate: "2025-05-31",
    ossSupportEndDate: "2026-06-30",
    commercialSupportEndDate: "2032-06-30",
  },
  {
    name: "7.1.x",
    initialReleaseDate: "2026-06-30",
    ossSupportEndDate: "2027-07-31",
    commercialSupportEndDate: "2028-07-31",
  },
];

describe("listGenerations", () => {
  it("is what spring-versions shows, the oldest first, with main as the newest OSS branch", () => {
    expect(listGenerations(generations, TODAY)).toEqual([
      { type: "COMMERCIAL", generation: "6.4.x", branch: "6.4.x" },
      { type: "COMMERCIAL", generation: "6.5.x", branch: "6.5.x" },
      { type: "OSS", generation: "7.0.x", branch: "7.0.x" },
      { type: "OSS", generation: "7.1.x", branch: "7.1.x" },
      { type: "OSS", generation: "7.2.x", branch: "main" },
    ]);
  });

  it("drops a generation whose commercial support ended, and one with no end date for it is kept out too", () => {
    const list = listGenerations(
      [
        {
          name: "7.0.x",
          initialReleaseDate: "2025-11-30",
          ossSupportEndDate: null,
          commercialSupportEndDate: "2027-01-01",
        },
        {
          name: "6.0.x",
          initialReleaseDate: "2022-11-30",
          ossSupportEndDate: "2020-01-01",
          commercialSupportEndDate: "2026-11-18",
        },
        {
          name: "6.1.x",
          initialReleaseDate: "2023-05-31",
          ossSupportEndDate: "2020-01-01",
          commercialSupportEndDate: null,
        },
      ],
      TODAY,
    );
    expect(list).toEqual([
      { type: "COMMERCIAL", generation: "7.0.x", branch: "7.0.x" },
    ]);
  });

  it("counts the last day of support as supported", () => {
    const list = listGenerations(
      [
        {
          name: "7.0.x",
          initialReleaseDate: "2025-11-30",
          ossSupportEndDate: TODAY,
          commercialSupportEndDate: TODAY,
        },
      ],
      TODAY,
    );
    expect(list).toEqual([
      { type: "OSS", generation: "7.0.x", branch: "main" },
    ]);
  });
});

// What api.spring.io says for spring-session: 2021.2.x, 3.4.x and 3.5.x are commercial (long-term
// support), 4.0.x and 4.1.x are OSS, and 4.2.x is the next one (its branch is main). 2021.2.x is
// older than 3.4.x, though 2021 is more than 3, and 3.3.x and older have no support left.
const session = [
  {
    name: "4.2.x",
    initialReleaseDate: "2026-11-30",
    ossSupportEndDate: "2027-12-31",
    commercialSupportEndDate: "2028-12-31",
  },
  {
    name: "2021.2.x",
    initialReleaseDate: "2022-05-31",
    ossSupportEndDate: "2023-06-30",
    commercialSupportEndDate: "2029-06-30",
  },
  {
    name: "3.5.x",
    initialReleaseDate: "2025-05-31",
    ossSupportEndDate: "2026-06-30",
    commercialSupportEndDate: "2032-06-30",
  },
  {
    name: "4.0.x",
    initialReleaseDate: "2025-11-30",
    ossSupportEndDate: "2026-12-31",
    commercialSupportEndDate: "2027-12-31",
  },
  {
    name: "3.3.x",
    initialReleaseDate: "2024-05-31",
    ossSupportEndDate: "2025-06-30",
    commercialSupportEndDate: "2026-06-30",
  },
  {
    name: "3.4.x",
    initialReleaseDate: "2024-11-30",
    ossSupportEndDate: "2025-12-31",
    commercialSupportEndDate: "2026-12-31",
  },
  {
    name: "4.1.x",
    initialReleaseDate: "2026-06-30",
    ossSupportEndDate: "2027-07-31",
    commercialSupportEndDate: "2028-07-31",
  },
];

describe("the generations of Spring Session, whose oldest long-term support one is 2021.2.x", () => {
  it("are in the order of their release, and not of their numbers", () => {
    expect(listGenerations(session, TODAY)).toEqual([
      { type: "COMMERCIAL", generation: "2021.2.x", branch: "2021.2.x" },
      { type: "COMMERCIAL", generation: "3.4.x", branch: "3.4.x" },
      { type: "COMMERCIAL", generation: "3.5.x", branch: "3.5.x" },
      { type: "OSS", generation: "4.0.x", branch: "4.0.x" },
      { type: "OSS", generation: "4.1.x", branch: "4.1.x" },
      { type: "OSS", generation: "4.2.x", branch: "main" },
    ]);
  });

  it("are chosen as they come, and an override in the order of the release is accepted", () => {
    const choose = (branches, ltsBranches) =>
      chooseBranches({
        generations: session,
        today: TODAY,
        branches,
        ltsBranches,
      });
    expect(choose("", "")).toEqual({
      oss: ["4.0.x", "4.1.x", "main"],
      lts: ["2021.2.x", "3.4.x", "3.5.x"],
    });
    expect(choose("", "2021.2.x,3.4.x").lts).toEqual(["2021.2.x", "3.4.x"]);
    expect(choose("", "3.4.x,3.5.x").lts).toEqual(["3.4.x", "3.5.x"]);
  });

  it("refuse an override in the order of the numbers, which would merge the wrong way", () => {
    expect(() =>
      chooseBranches({
        generations: session,
        today: TODAY,
        branches: "",
        ltsBranches: "3.4.x,3.5.x,2021.2.x",
      }),
    ).toThrow(/not in the order of the versions, oldest first/);
  });

  it("fail for a generation that has no initial release date, which is the order", () => {
    expect(() =>
      listGenerations(
        [
          {
            name: "3.4.x",
            ossSupportEndDate: "2025-12-31",
            commercialSupportEndDate: "2026-12-31",
          },
        ],
        TODAY,
      ),
    ).toThrow("The generation 3.4.x has no initialReleaseDate");
  });

  it("ignore a generation with no date when it has no support left", () => {
    expect(
      listGenerations(
        [
          {
            name: "1.0.x",
            ossSupportEndDate: "2010-01-01",
            commercialSupportEndDate: "2011-01-01",
          },
        ],
        TODAY,
      ),
    ).toEqual([]);
  });
});

describe("parseList", () => {
  it("splits on commas and trims the blanks", () => {
    expect(parseList(" 7.1.x , main ,")).toEqual(["7.1.x", "main"]);
    expect(parseList("")).toEqual([]);
    expect(parseList(undefined)).toEqual([]);
  });
});

describe("chooseBranches", () => {
  const choose = (branches = "", ltsBranches = "") =>
    chooseBranches({ generations, today: TODAY, branches, ltsBranches });

  it("takes all the discovered branches without an override", () => {
    expect(choose()).toEqual({
      oss: ["7.0.x", "7.1.x", "main"],
      lts: ["6.4.x", "6.5.x"],
    });
  });

  it("takes an override of each kind in the order given", () => {
    expect(choose("7.1.x,main", "6.5.x")).toEqual({
      oss: ["7.1.x", "main"],
      lts: ["6.5.x"],
    });
  });

  it("allows dropping the oldest or the newest, and trims the blanks", () => {
    expect(choose(" 7.0.x , 7.1.x ").oss).toEqual(["7.0.x", "7.1.x"]);
    expect(choose("main").oss).toEqual(["main"]);
  });

  it.each([
    [
      "a branch that is not discovered",
      "7.3.x",
      /7\.3\.x in branches is not a OSS generation/,
    ],
    [
      "an embargoed branch",
      "embargoed/frozen/7.0.x",
      /embargoed\/frozen\/7\.0\.x in branches is not/,
    ],
    [
      "a long-term support generation",
      "7.0.x,6.5.x",
      /6\.5\.x in branches is a commercial \(long-term support\) generation/,
    ],
    ["a duplicate", "7.0.x,7.0.x", /7\.0\.x is twice in branches/],
    [
      "the wrong order",
      "main,7.1.x",
      /not in the order of the versions, oldest first/,
    ],
    [
      "main before the older ones",
      "7.0.x,main,7.1.x",
      /not in the order of the versions/,
    ],
    [
      "a gap in the middle",
      "7.0.x,main",
      /skips 7\.1\.x, which is in the middle of the chain/,
    ],
    ["only commas", ",", /branches is empty/],
  ])("fails for %s", (_, branches, message) => {
    expect(() => choose(branches)).toThrow(message);
  });

  it("fails for an OSS generation among the long-term support ones, and for a gap there", () => {
    expect(() => choose("", "7.0.x")).toThrow(
      /7\.0\.x in lts-branches is a OSS generation/,
    );
    const four = [
      ...generations,
      {
        name: "6.6.x",
        initialReleaseDate: "2025-08-31",
        ossSupportEndDate: "2026-06-30",
        commercialSupportEndDate: "2030-06-30",
      },
    ];
    expect(() =>
      chooseBranches({
        generations: four,
        today: TODAY,
        branches: "",
        ltsBranches: "6.4.x,6.6.x",
      }),
    ).toThrow(/skips 6\.5\.x/);
  });

  it("lists every problem, not only the first", () => {
    expect(() => choose("7.3.x", "7.0.x")).toThrow(
      /7\.3\.x in branches[\s\S]*7\.0\.x in lts-branches/,
    );
  });
});

describe("checkOverride", () => {
  it("has no problem for the whole list", () => {
    const discovered = [{ branch: "7.0.x" }, { branch: "main" }];
    expect(
      checkOverride({
        name: "branches",
        kind: "OSS",
        entries: ["7.0.x", "main"],
        discovered,
        other: [],
      }).problems,
    ).toEqual([]);
  });
});

describe("readGenerations and run", () => {
  const response = (body, init = {}) => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: init.statusText ?? "OK",
    json: async () => body,
  });

  it("reads the generations of the project", async () => {
    const urls = [];
    const fetch = async (url) => {
      urls.push(url);
      return response({ _embedded: { generations } });
    };
    const result = await run(
      { project: "spring-security", today: TODAY },
      { fetch },
    );
    expect(urls).toEqual([
      "https://api.spring.io/projects/spring-security/generations",
    ]);
    expect(result.oss).toEqual(["7.0.x", "7.1.x", "main"]);
  });

  it("fails if the API fails or has no generations", async () => {
    await expect(
      readGenerations(
        { apiUrl: "https://api.example.com/", project: "x" },
        {
          fetch: async () =>
            response({}, { ok: false, status: 404, statusText: "Not Found" }),
        },
      ),
    ).rejects.toThrow(/failed with 404 Not Found/);
    await expect(
      readGenerations(
        { apiUrl: "https://api.example.com", project: "x" },
        { fetch: async () => response({}) },
      ),
    ).rejects.toThrow(/has no generations/);
    await expect(
      readGenerations(
        { apiUrl: "https://api.example.com", project: "x" },
        {
          fetch: async () => {
            throw new Error("offline");
          },
        },
      ),
    ).rejects.toThrow(/failed: offline/);
  });
});

describe("the action as a program", () => {
  it("fails with the problems when the override is wrong, before reading anything it cannot read", async () => {
    const result = await runAction("src/index.js", {
      project: "spring-security",
      "api-url": "http://127.0.0.1:1",
      branches: "main",
    });
    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(
      /Reading http:\/\/127\.0\.0\.1:1/,
    );
  });
});
