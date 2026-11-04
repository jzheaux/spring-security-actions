import { describe, expect, it } from "vitest";
import { plan } from "../src/index.js";
import { runAction } from "./support/run-action.js";

describe("plan", () => {
  it("builds the release and an internal snapshot for a frozen embargoed branch", () => {
    expect(
      plan({ refName: "embargoed/frozen/7.0.x", version: "7.0.1-SNAPSHOT" }),
    ).toEqual({
      release: true,
      kind: "frozen",
      baseVersion: "7.0.1-SNAPSHOT",
      hotfix: false,
      hotfixOfSnapshot: "",
      hotfixOfRelease: "",
      hotfixOfVersion: "",
      ossBranch: "7.0.x",
      ossTag: "",
      deploymentDestination: "Maven Central",
      frozenBranch: "",
      snapshotBranch: "embargoed/7.0.1-INTERNAL-SNAPSHOT",
      snapshotVersion: "7.0.1-INTERNAL-SNAPSHOT",
    });
  });

  it("names the internal snapshot of a .0 version without a release candidate", () => {
    const result = plan({
      refName: "embargoed/frozen/main",
      version: "7.1.0-SNAPSHOT",
    });
    expect(result.snapshotBranch).toBe("embargoed/7.1.0-INTERNAL-SNAPSHOT");
    expect(result.snapshotVersion).toBe("7.1.0-INTERNAL-SNAPSHOT");
    expect(result.baseVersion).toBe("7.1.0-SNAPSHOT");
  });

  it("builds a hotfix for an active embargoed branch, on the snapshot and on the release, and no internal snapshot of its own", () => {
    expect(
      plan({ refName: "embargoed/active/7.0.x", version: "7.0.1-SNAPSHOT" }),
    ).toEqual({
      release: true,
      kind: "active",
      baseVersion: "7.0.1.1-SNAPSHOT",
      hotfix: true,
      hotfixOfSnapshot: "embargoed/7.0.1-INTERNAL-SNAPSHOT",
      hotfixOfRelease: "release/7.0.1",
      hotfixOfVersion: "7.0.1",
      ossBranch: "7.0.x",
      ossTag: "7.0.1",
      deploymentDestination: "Spring Enterprise",
      frozenBranch: "embargoed/frozen/7.0.x",
      snapshotBranch: "embargoed/7.0.1.1-SNAPSHOT",
      snapshotVersion: "7.0.1.1-SNAPSHOT",
    });
  });

  it("builds the release and a plain snapshot for a long-term support embargoed branch", () => {
    expect(
      plan({ refName: "embargoed/lts/5.8.x", version: "5.8.30-SNAPSHOT" }),
    ).toEqual({
      release: true,
      kind: "lts",
      baseVersion: "5.8.30-SNAPSHOT",
      hotfix: false,
      hotfixOfSnapshot: "",
      hotfixOfRelease: "",
      hotfixOfVersion: "",
      ossBranch: "5.8.x",
      ossTag: "",
      deploymentDestination: "Spring Enterprise",
      frozenBranch: "",
      snapshotBranch: "embargoed/5.8.30-SNAPSHOT",
      snapshotVersion: "5.8.30-SNAPSHOT",
    });
  });

  it("plans the hotfix of a .0 version for an active embargoed branch: the workflow decides if its next release is the GA", () => {
    expect(
      plan({ refName: "embargoed/active/main", version: "7.1.0-SNAPSHOT" }),
    ).toMatchObject({
      release: true,
      kind: "active",
      baseVersion: "7.1.0.1-SNAPSHOT",
      hotfix: true,
      hotfixOfSnapshot: "embargoed/7.1.0-INTERNAL-SNAPSHOT",
      hotfixOfRelease: "release/7.1.0",
      hotfixOfVersion: "7.1.0",
      ossBranch: "main",
      ossTag: "7.1.0",
      snapshotBranch: "embargoed/7.1.0.1-SNAPSHOT",
    });
  });

  it("takes a branch of any name under frozen or active", () => {
    expect(
      plan({
        refName: "embargoed/frozen/try-no-train",
        version: "7.0.3-SNAPSHOT",
      }).kind,
    ).toBe("frozen");
    expect(
      plan({
        refName: "embargoed/active/try-hotfix",
        version: "7.0.3-SNAPSHOT",
      }).hotfixOfRelease,
    ).toBe("release/7.0.3");
  });

  it("names the frozen embargoed branch of the same generation for an active one, whatever the generation is called", () => {
    expect(
      plan({ refName: "embargoed/active/main", version: "7.1.1-SNAPSHOT" })
        .frozenBranch,
    ).toBe("embargoed/frozen/main");
    expect(
      plan({
        refName: "embargoed/active/try-hotfix",
        version: "7.0.3-SNAPSHOT",
      }).frozenBranch,
    ).toBe("embargoed/frozen/try-hotfix");
  });

  it.each([
    [
      "a branch that is not an embargoed branch",
      "feature/x",
      "7.0.1-SNAPSHOT",
      "is not an embargoed branch",
    ],
    [
      "a version that is not a snapshot",
      "embargoed/frozen/7.0.x",
      "7.0.1",
      "expected <major>.<minor>.<patch>-SNAPSHOT",
    ],
    [
      "a milestone as a snapshot",
      "embargoed/frozen/7.0.x",
      "7.1.0-M1-SNAPSHOT",
      "expected <major>.<minor>.<patch>-SNAPSHOT",
    ],
    [
      "a hotfix on a frozen embargoed branch",
      "embargoed/frozen/7.0.x",
      "7.0.1.1-SNAPSHOT",
      "has no internal snapshot",
    ],
    [
      "a hotfix on an active embargoed branch",
      "embargoed/active/7.0.x",
      "7.0.1.1-SNAPSHOT",
      "a hotfix already",
    ],
    [
      "a hotfix on a long-term support embargoed branch",
      "embargoed/lts/7.0.x",
      "7.0.1.1-SNAPSHOT",
      "a long-term support branch releases its own version",
    ],
    [
      "an embargoed branch with nothing under it",
      "embargoed/frozen",
      "7.0.1-SNAPSHOT",
      "is not an embargoed branch",
    ],
  ])("fails for %s", (_, refName, version, message) => {
    expect(() => plan({ refName, version })).toThrow(message);
  });
});

// The actions run as programs: the sources, and the bundle that GitHub runs (dist/).
describe.each([["src/index.js"], ["dist/index.js"]])(
  "the program %s",
  (entry) => {
    it("writes its outputs for a hotfix", async () => {
      const result = await runAction(entry, {
        "ref-name": "embargoed/active/7.0.x",
        version: "7.0.1-SNAPSHOT",
      });
      expect(result.code).toBe(0);
      expect(result.outputs).toEqual({
        release: "true",
        kind: "active",
        "base-version": "7.0.1.1-SNAPSHOT",
        hotfix: "true",
        "hotfix-of-snapshot": "embargoed/7.0.1-INTERNAL-SNAPSHOT",
        "hotfix-of-release": "release/7.0.1",
        "hotfix-of-version": "7.0.1",
        "oss-branch": "7.0.x",
        "oss-tag": "7.0.1",
        "deployment-destination": "Spring Enterprise",
        "frozen-branch": "embargoed/frozen/7.0.x",
        "snapshot-branch": "embargoed/7.0.1.1-SNAPSHOT",
        "snapshot-version": "7.0.1.1-SNAPSHOT",
      });
      expect(result.stdout).toContain(
        "an active embargoed branch: the hotfix 7.0.1.1 of 7.0.1-SNAPSHOT",
      );
    });

    it("writes the outputs of a frozen embargoed branch, with no hotfix bases", async () => {
      const result = await runAction(entry, {
        "ref-name": "embargoed/frozen/main",
        version: "7.1.0-SNAPSHOT",
      });
      expect(result.outputs).toMatchObject({
        release: "true",
        kind: "frozen",
        hotfix: "false",
        "hotfix-of-snapshot": "",
        "hotfix-of-release": "",
        "oss-branch": "main",
        "oss-tag": "",
        "deployment-destination": "Maven Central",
        "frozen-branch": "",
        "snapshot-branch": "embargoed/7.1.0-INTERNAL-SNAPSHOT",
      });
    });

    it("writes the outputs of the hotfix of a .0 version", async () => {
      const result = await runAction(entry, {
        "ref-name": "embargoed/active/main",
        version: "7.1.0-SNAPSHOT",
      });
      expect(result.code).toBe(0);
      expect(result.outputs).toMatchObject({
        release: "true",
        "base-version": "7.1.0.1-SNAPSHOT",
        "hotfix-of-version": "7.1.0",
      });
    });

    it("fails with an error that GitHub shows", async () => {
      const result = await runAction(entry, {
        "ref-name": "feature/x",
        version: "7.0.1-SNAPSHOT",
      });
      expect(result.code).toBe(1);
      expect(result.stdout).toContain(
        "::error::feature/x is not an embargoed branch",
      );
    });
  },
);
