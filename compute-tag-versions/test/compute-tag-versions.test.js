import { describe, expect, it } from "vitest";
import { computeTagVersions } from "../src/index.js";
import { runAction } from "./support/run-action.js";

describe("computeTagVersions", () => {
  it.each([
    ["v7.0.1", "7.0.1", "7.0.1-SNAPSHOT"],
    ["7.0.1", "7.0.1", "7.0.1-SNAPSHOT"],
    ["7.0.1.1", "7.0.1.1", "7.0.1.1-SNAPSHOT"],
    ["v7.1.0-M1", "7.1.0-M1", "7.1.0-SNAPSHOT"],
    ["7.1.0-RC12", "7.1.0-RC12", "7.1.0-SNAPSHOT"],
    ["v7.1.0-RC1", "7.1.0-RC1", "7.1.0-SNAPSHOT"],
    ["7.1.0-RC", "7.1.0-RC", "7.1.0-RC-SNAPSHOT"],
    ["vv7.0.1", "v7.0.1", "v7.0.1-SNAPSHOT"],
  ])("takes %s", (tag, releaseVersion, snapshotVersion) => {
    expect(computeTagVersions(tag)).toEqual({
      releaseVersion,
      snapshotVersion,
    });
  });

  it.each([[""], ["v"], [undefined]])("rejects %j", (tag) => {
    expect(() => computeTagVersions(tag)).toThrow(/not a tag/);
  });
});

describe("the action", () => {
  it("sets the outputs", async () => {
    const result = await runAction("src/index.js", { tag: "v7.1.0-RC1" });
    expect(result.code).toBe(0);
    expect(result.outputs).toEqual({
      "release-version": "7.1.0-RC1",
      "snapshot-version": "7.1.0-SNAPSHOT",
    });
  });

  it("fails without a tag", async () => {
    const result = await runAction("src/index.js", { tag: "" });
    expect(result.code).not.toBe(0);
  });
});
