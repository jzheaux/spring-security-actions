import { describe, expect, it } from "vitest";
import {
  compareVersions,
  parseVersion,
  previousVersion,
} from "../src/versions.js";

describe("parseVersion", () => {
  it.each(["7.0.9", "7.0.9.1", "7.2.0-M1", "7.2.0-RC1"])("reads %s", (v) => {
    expect(parseVersion(v)).toBeDefined();
  });

  it.each(["7.0.9-SNAPSHOT", "7.0", "main", "release/7.0.9", "", undefined])(
    "does not read %j",
    (v) => {
      expect(parseVersion(v)).toBeUndefined();
    },
  );
});

describe("compareVersions", () => {
  it("orders the numbers as numbers, not as text", () => {
    expect(compareVersions("7.0.10", "7.0.9")).toBeGreaterThan(0);
    expect(compareVersions("7.10.0", "7.9.0")).toBeGreaterThan(0);
  });

  it("puts a hotfix after its release", () => {
    expect(compareVersions("7.0.9.1", "7.0.9")).toBeGreaterThan(0);
    expect(compareVersions("7.0.9.2", "7.0.9.1")).toBeGreaterThan(0);
    expect(compareVersions("7.0.10", "7.0.9.5")).toBeGreaterThan(0);
  });

  it("puts milestones before release candidates before the release", () => {
    expect(compareVersions("7.2.0-M2", "7.2.0-M1")).toBeGreaterThan(0);
    expect(compareVersions("7.2.0-RC1", "7.2.0-M2")).toBeGreaterThan(0);
    expect(compareVersions("7.2.0", "7.2.0-RC1")).toBeGreaterThan(0);
    expect(compareVersions("7.2.0-RC1", "7.1.9")).toBeGreaterThan(0);
    expect(compareVersions("7.0.9", "7.0.9")).toBe(0);
  });
});

describe("previousVersion", () => {
  const all = [
    "7.0.7",
    "7.0.8",
    "7.0.9",
    "7.0.9.1",
    "7.1.0",
    "release/7.0.8",
    "7.0.10-SNAPSHOT",
  ];

  it("is the greatest version below it", () => {
    expect(previousVersion("7.0.9", all)).toBe("7.0.8");
    expect(previousVersion("7.0.9.1", all)).toBe("7.0.9");
    expect(previousVersion("7.0.9.2", all)).toBe("7.0.9.1");
  });

  it("goes back to the generation before when there is none in it", () => {
    expect(previousVersion("7.1.0", all)).toBe("7.0.9.1");
  });

  it("goes back to the release candidate before the release", () => {
    expect(previousVersion("7.2.0", ["7.2.0-M1", "7.2.0-RC1", "7.1.4"])).toBe(
      "7.2.0-RC1",
    );
    expect(
      previousVersion("7.2.0-RC1", ["7.2.0-M1", "7.2.0-M2", "7.1.4"]),
    ).toBe("7.2.0-M2");
  });

  it("is undefined when there is none, or when the version is not a release", () => {
    expect(previousVersion("7.0.7", all)).toBeUndefined();
    expect(previousVersion("7.0.9-SNAPSHOT", all)).toBeUndefined();
    expect(previousVersion("7.0.9", [])).toBeUndefined();
  });
});
