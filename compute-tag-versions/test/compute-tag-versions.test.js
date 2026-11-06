import { describe, expect, it } from "vitest";
import { computeTagVersions } from "../src/index.js";
import { runAction } from "./support/run-action.js";

describe("computeTagVersions", () => {
  it.each([
    ["7.0.1", "7.0.1", "7.0.x", false],
    ["7.0.1.1", "7.0.1.1", "7.0.x", true],
    ["7.1.0-M1", "7.1.0", "7.1.x", false],
    ["7.1.0-RC12", "7.1.0", "7.1.x", false],
    ["7.2.0", "7.2.0", "7.2.x", false],
    ["2021.2.9", "2021.2.9", "2021.2.x", false],
    ["5.8.30", "5.8.30", "5.8.x", false],
  ])("takes %s", (tag, baseVersion, generation, hotfix) => {
    expect(computeTagVersions(tag)).toEqual({
      releaseVersion: tag,
      baseVersion,
      generation,
      hotfix,
    });
  });

  it("ignores the blanks around the tag", () => {
    expect(computeTagVersions(" 7.0.1\n").releaseVersion).toBe("7.0.1");
  });

  it.each([
    [""],
    ["v7.0.1"],
    ["v"],
    ["7.0"],
    ["7.0.1.1.1"],
    ["7.1.0-RC"],
    ["7.1.0-M"],
    ["7.1.0-SNAPSHOT"],
    ["release/7.0.1"],
    [undefined],
  ])("rejects %j", (tag) => {
    expect(() => computeTagVersions(tag)).toThrow(/is not a tag of a version/);
  });
});

describe("the action", () => {
  it("sets the outputs", async () => {
    const result = await runAction("src/index.js", { tag: "7.1.0-RC1" });
    expect(result.code).toBe(0);
    expect(result.outputs).toEqual({
      "release-version": "7.1.0-RC1",
      "base-version": "7.1.0",
      generation: "7.1.x",
      hotfix: "false",
    });
  });

  it("says that a hotfix is one", async () => {
    const result = await runAction("src/index.js", { tag: "7.0.1.1" });
    expect(result.outputs.hotfix).toBe("true");
    expect(result.outputs.generation).toBe("7.0.x");
  });

  it("fails with an error that GitHub shows for a tag that is not a version", async () => {
    const result = await runAction("src/index.js", { tag: "v7.0.1" });
    expect(result.code).not.toBe(0);
    expect(result.stdout).toContain("::error::");
  });

  it("fails without a tag", async () => {
    const result = await runAction("src/index.js", { tag: "" });
    expect(result.code).not.toBe(0);
  });
});
