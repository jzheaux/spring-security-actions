import { describe, expect, it } from "vitest";
import { nameRepositories } from "../src/index.js";
import { runAction } from "./support/run-action.js";

describe("nameRepositories", () => {
  it("is the name without -commercial", () => {
    expect(
      nameRepositories("spring-projects/spring-security-commercial"),
    ).toEqual({
      owner: "spring-projects",
      project: "spring-security",
      ossRepository: "spring-projects/spring-security",
      commercialRepository: "spring-projects/spring-security-commercial",
    });
  });

  it("names the commercial repository when it runs from the OSS one", () => {
    expect(
      nameRepositories("spring-projects/spring-session").commercialRepository,
    ).toBe("spring-projects/spring-session-commercial");
  });

  it("is the same for a repository that is not commercial", () => {
    expect(nameRepositories("rwinch/spring-merge").project).toBe(
      "spring-merge",
    );
  });

  it("takes only the last -commercial", () => {
    expect(nameRepositories("o/a-commercial-commercial").project).toBe(
      "a-commercial",
    );
    expect(nameRepositories("o/commercial-a").project).toBe("commercial-a");
  });

  it.each([
    "",
    undefined,
    "spring-security",
    "a/b/c",
    "a/",
    "/b",
    "o/-commercial",
    " a/b",
  ])("does not take %j", (repository) => {
    expect(() => nameRepositories(repository)).toThrow(
      /is not a repository|has no name/,
    );
  });
});

describe.each([["src/index.js"], ["dist/index.js"]])(
  "the program %s",
  (entry) => {
    it("names them from the input", async () => {
      const result = await runAction(entry, {
        repository: "rwinch/spring-merge-commercial",
      });
      expect(result.code).toBe(0);
      expect(result.outputs).toEqual({
        owner: "rwinch",
        project: "spring-merge",
        "oss-repository": "rwinch/spring-merge",
        "commercial-repository": "rwinch/spring-merge-commercial",
      });
    });

    it("takes the repository of the workflow when there is no input", async () => {
      const result = await runAction(
        entry,
        {},
        { GITHUB_REPOSITORY: "o/p-commercial" },
      );
      expect(result.outputs.project).toBe("p");
    });

    it("fails with an error that GitHub shows", async () => {
      const result = await runAction(entry, { repository: "nonsense" });
      expect(result.code).toBe(1);
      expect(result.stdout).toContain("::error::nonsense is not a repository");
    });
  },
);
