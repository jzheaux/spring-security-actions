import { describe, expect, it } from "vitest";
import { render } from "../src/index.js";

const plan = {
  project: "spring-security",
  train: "2026.11.19",
  problems: [],
  oss: [
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
      generation: "main",
      branch: "main",
      frozen: "embargoed/frozen/main",
      active: "embargoed/active/main",
      current: "7.2.0-SNAPSHOT",
      next: "7.2.0-SNAPSHOT",
      bump: false,
    },
  ],
  lts: [
    {
      generation: "6.5.x",
      branch: "embargoed/lts/6.5.x",
      current: "6.5.11-SNAPSHOT",
      next: "6.5.12-SNAPSHOT",
      bump: true,
    },
  ],
  releases: [
    {
      version: "7.0.5",
      branch: "release/7.0.5",
      of: ["7.0.x", "embargoed/frozen/7.0.x"],
      hotfix: false,
      milestone: {
        repository: "spring-projects/spring-security",
        title: "7.0.5",
        number: 312,
        url: "https://github.com/spring-projects/spring-security/milestone/312",
        state: "open",
        open: 2,
        closed: 17,
      },
    },
    {
      version: "7.0.5.1",
      branch: "release/7.0.5.1",
      of: ["embargoed/active/7.0.x"],
      hotfix: true,
      milestone: {
        repository: "spring-projects/spring-security-commercial",
        title: "7.0.5.1",
        number: 41,
        url: "https://github.com/spring-projects/spring-security-commercial/milestone/41",
        state: "open",
        open: 0,
        closed: 0,
      },
    },
    {
      version: "6.5.11",
      branch: "release/6.5.11",
      of: ["embargoed/lts/6.5.x"],
      hotfix: false,
      milestone: {
        repository: "spring-projects/spring-security-commercial",
        title: "6.5.11",
        number: 38,
        url: "https://github.com/spring-projects/spring-security-commercial/milestone/38",
        state: "closed",
        open: 0,
        closed: 6,
      },
    },
  ],
};

const apply = {
  merges: [
    {
      kind: "across",
      message: "merge(ours): 7.0.x into main",
      into: "main",
      outcome: "merged",
    },
    {
      kind: "down",
      message: "Merge branch '7.0.x' into 7.0.x",
      into: "embargoed/frozen/7.0.x",
      outcome: "merged",
    },
    {
      kind: "across",
      message: "merge(ours): 6.4.x into 6.5.x",
      into: "embargoed/lts/6.5.x",
      outcome: "up-to-date",
    },
  ],
  rotation: [
    { branch: "embargoed/frozen/7.0.x", active: "embargoed/active/7.0.x" },
  ],
  bumps: [{ branch: "7.0.x", commit: "1234567890abcdef" }],
};

describe("render", () => {
  it("is a dry run with the versions, what would be marked ready, and the merges", () => {
    const markdown = render({ plan, apply, dryRun: true });
    expect(markdown).toMatch(
      /^# Code freeze: spring-security, release train 2026\.11\.19 {5}DRY RUN/,
    );
    expect(markdown).toContain(
      "| 7.0.x | OSS | 7.0.5-SNAPSHOT | 7.0.6-SNAPSHOT | Next Development Version (7.0.6-SNAPSHOT) (1234567) |",
    );
    expect(markdown).toContain(
      "| embargoed/frozen/7.0.x | commercial | 7.0.5-SNAPSHOT | 7.0.6-SNAPSHOT | arrives by the merge of 7.0.x (no commit of its own) |",
    );
    expect(markdown).toContain(
      "| main | OSS | 7.2.0-SNAPSHOT | 7.2.0-SNAPSHOT | none: the version stays, as 7.2.0 has no GA milestone yet |",
    );
    expect(markdown).toContain(
      "| release/7.0.5 | 7.0.x, embargoed/frozen/7.0.x | Not run, this is a dry run |",
    );
    expect(markdown).toContain(
      "| release/7.0.5.1 | embargoed/active/7.0.x (a hotfix) | Not run, this is a dry run |",
    );
    expect(markdown).toContain(
      "| across | merge(ours): 7.0.x into main | main | target |",
    );
    expect(markdown).toContain(
      "| down | Merge branch '7.0.x' into 7.0.x | embargoed/frozen/7.0.x | source |",
    );
    expect(markdown).toContain("(already merged, nothing to do)");
    expect(markdown).toContain(
      "| rotation | fast forward to embargoed/active/7.0.x | embargoed/frozen/7.0.x | same |",
    );
  });

  describe("the milestones", () => {
    const commercial = "spring-projects/spring-security-commercial";
    it("says what a dry run would do with each, from the plan", () => {
      const markdown = render({ plan, apply, dryRun: true });
      expect(markdown).toContain("## Milestones closed");
      expect(markdown).toContain(
        "| [7.0.5](https://github.com/spring-projects/spring-security/milestone/312) | spring-projects/spring-security | 7.0.x, embargoed/frozen/7.0.x | 2 / 17 | Would be closed with 2 open issues |",
      );
      expect(markdown).toContain(
        `| [7.0.5.1](https://github.com/${commercial}/milestone/41) | ${commercial} | embargoed/active/7.0.x (a hotfix) | 0 / 0 | Would be deleted, it has no issues |`,
      );
      expect(markdown).toContain("| 0 / 6 | Already closed |");
    });

    it("says what was done, and links none that was deleted", () => {
      const milestones = [
        {
          version: "7.0.5",
          result: "closed-with-open",
          open: 1,
          closed: 18,
          url: "https://github.com/spring-projects/spring-security/milestone/312",
        },
        { version: "7.0.5.1", result: "deleted", open: 0, closed: 0 },
        { version: "6.5.11", result: "failed", error: "403 Forbidden" },
      ];
      const markdown = render({ plan, apply, milestones, dryRun: false });
      expect(markdown).toContain("| 1 / 18 | Closed with 1 open issue |");
      expect(markdown).toContain(
        `| 7.0.5.1 | ${commercial} | embargoed/active/7.0.x (a hotfix) | 0 / 0 | Deleted, it had no issues |`,
      );
      expect(markdown).toContain("| 0 / 6 | Failed: 403 Forbidden |");
    });

    it("says that they were not closed if the freeze did not get to it", () => {
      const markdown = render({
        plan,
        apply,
        dryRun: false,
        status: "failure",
      });
      expect(markdown).toContain(
        "| Not closed, the freeze did not get to it |",
      );
    });
  });

  it("links the run of each ready, and says what failed", () => {
    const ready = [
      {
        branch: "release/7.0.5",
        conclusion: "success",
        runUrl: "https://example.com/runs/1",
      },
      {
        branch: "release/7.0.5.1",
        conclusion: "failure",
        runUrl: "https://example.com/runs/2",
      },
      {
        branch: "release/6.5.11",
        conclusion: "not-found",
        runUrl: "https://example.com/runs",
      },
    ];
    const markdown = render({
      plan,
      apply,
      ready,
      dryRun: false,
      status: "failure",
    });
    expect(markdown).toMatch(/release train 2026\.11\.19 {5}FAILED/);
    expect(markdown).not.toContain("DRY RUN");
    expect(markdown).toContain("[Succeeded](https://example.com/runs/1)");
    expect(markdown).toContain("[Failed: failure](https://example.com/runs/2)");
    expect(markdown).toContain(
      "[The run could not be found](https://example.com/runs)",
    );
  });

  it("says that a release is ready already, in a dry run or not", () => {
    const ready = {
      ...plan,
      releases: [{ ...plan.releases[0], alreadyReady: true }, plan.releases[1]],
    };
    for (const dryRun of [true, false]) {
      const markdown = render({ plan: ready, apply, dryRun });
      expect(markdown).toContain(
        "| release/7.0.5 | 7.0.x, embargoed/frozen/7.0.x | Ready already, skipped |",
      );
    }
  });

  it("lists every problem of a plan that stopped the freeze, and no ready table", () => {
    const stopped = {
      ...plan,
      problems: [
        "release/7.1.1 has not joined the release train 2026.11.19",
        "release/7.2.0-M2 does not exist",
      ],
    };
    const markdown = render({ plan: stopped, status: "failure", dryRun: true });
    expect(markdown).toContain(
      "The plan found 2 problems. Nothing was merged, dispatched or pushed.",
    );
    expect(markdown).toContain(
      "- release/7.1.1 has not joined the release train 2026.11.19",
    );
    expect(markdown).toContain("## Versions (what would have been done)");
    expect(markdown).not.toContain("## Releases marked ready");
    expect(markdown).not.toContain("## Merges");
  });

  it("says the OSS leak check, and what a failed one found", () => {
    const push = (problems) => ({
      mode: "check",
      commercial: { branches: [1, 2, 3] },
      oss: { branches: [1, 2] },
      leakCheck: { commits: 4, problems },
    });
    expect(render({ plan, apply, push: push([]), dryRun: true })).toContain(
      "- OSS leak check: 2 branches, 4 new commits, all made by this run, none of them in a commercial branch: OK",
    );
    const failed = render({
      plan,
      apply,
      push: push(["abc1234 is in the commercial repository"]),
      dryRun: true,
    });
    expect(failed).toContain(
      "- OSS leak check: FAILED, nothing was pushed:\n  - abc1234 is in the commercial repository",
    );
    expect(failed).toContain(
      "- commercial: git push --atomic (dry run), 3 branches",
    );
  });

  it("says that it stopped before the plan", () => {
    expect(render({ status: "failure" })).toContain(
      "The run stopped before it made a plan.",
    );
  });
});
