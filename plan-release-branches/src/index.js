import * as core from "@actions/core";
import { execute, isMain } from "./run.js";

const SNAPSHOT_VERSION = /^(\d+\.\d+\.\d+(?:\.\d+)?)-SNAPSHOT$/;
const HOTFIX = /^\d+\.\d+\.\d+\.\d+$/;

/**
 * Decides what the push of an embargoed branch builds, from the branch that was pushed
 * (embargoed/frozen/<generation>, embargoed/active/<generation> or embargoed/lts/<generation>) and the version of
 * gradle.properties on it (<version>-SNAPSHOT). It returns:
 *
 *   release           true: there is something to build. (The workflow ends the run before it
 *                     builds a hotfix of a .0 version whose next release is a milestone or a
 *                     release candidate, which have no hotfix.)
 *                     Everything else below is only there if it is true
 *   kind              frozen, active or lts
 *   baseVersion       the snapshot version that the release version is worked out from: the
 *                     version of the frozen branch (7.0.1-SNAPSHOT), or the hotfix version
 *                     of an active one (7.0.1.1-SNAPSHOT)
 *   hotfix            true for an active embargoed branch: a hotfix is built, and hotfix versions
 *                     of the dependencies are preferred
 *   hotfixOf          for a hotfix, the release branch that it fixes and is built on:
 *                     release/7.0.1-SNAPSHOT for 7.0.1-SNAPSHOT. Empty for a frozen embargoed branch
 *   hotfixOfVersion   the version of that release: 7.0.1. Empty for a frozen embargoed branch
 *   deploymentDestination
 *                     where the release is deployed to, as the release train names it:
 *                     Maven Central for a frozen embargoed branch, Spring Enterprise for an
 *                     active one (a hotfix is commercial) or a long-term support one
 *   frozenBranch      for an active embargoed branch, the frozen embargoed branch of the same
 *                     generation, which a hotfix is only built for if the active one differs
 *                     from it: embargoed/frozen/7.0.x for embargoed/active/7.0.x. Empty for a
 *                     frozen embargoed branch
 *   snapshotBranch    the branch of the snapshot that the release branch is built on (active)
 *                     or that is thrown away (frozen): embargoed/7.0.1-INTERNAL-SNAPSHOT,
 *                     embargoed/7.0.1.1-SNAPSHOT. A long-term support branch has a plain
 *                     snapshot of its own version: embargoed/5.8.30-SNAPSHOT
 *   snapshotVersion   the version of that branch: 7.0.1-INTERNAL-SNAPSHOT, 7.0.1.1-SNAPSHOT,
 *                     5.8.30-SNAPSHOT.
 *                     A snapshot never carries a milestone or a release candidate, so it is the
 *                     version of the branch with -SNAPSHOT replaced, and not the release.
 *                     A hotfix or a long-term support version never has an internal snapshot
 */
export function plan({ refName, version }) {
  let kind;
  if (refName.startsWith("embargoed/frozen/")) {
    kind = "frozen";
  } else if (refName.startsWith("embargoed/active/")) {
    kind = "active";
  } else if (refName.startsWith("embargoed/lts/")) {
    kind = "lts";
  } else {
    throw new Error(
      `${refName} is not an embargoed branch: expected embargoed/frozen/*, embargoed/active/* or embargoed/lts/*`,
    );
  }
  const match = SNAPSHOT_VERSION.exec(version);
  if (!match) {
    throw new Error(
      `${refName} has the version ${version}: expected <major>.<minor>.<patch>-SNAPSHOT`,
    );
  }
  const plain = match[1];

  if (kind === "lts") {
    if (HOTFIX.test(plain)) {
      throw new Error(
        `${refName} has the version ${version}, a hotfix: only an active embargoed branch has one, and a long-term support branch releases its own version`,
      );
    }
    // The snapshot of a long-term support version is a plain -SNAPSHOT, as a hotfix has: it is
    // commercial, and has the fixes for vulnerabilities, so the internal snapshot that OSS has (to
    // not get the OSS snapshot, which lacks them) is not needed. The release is built from the pushed commit.
    return {
      release: true,
      kind,
      baseVersion: version,
      hotfix: false,
      hotfixOf: "",
      hotfixOfVersion: "",
      deploymentDestination: "Spring Enterprise",
      frozenBranch: "",
      snapshotBranch: `embargoed/${plain}-SNAPSHOT`,
      snapshotVersion: `${plain}-SNAPSHOT`,
    };
  }

  if (kind === "frozen") {
    if (HOTFIX.test(plain)) {
      throw new Error(
        `${refName} has the version ${version}, a hotfix: only an active embargoed branch has one, and a hotfix has no internal snapshot`,
      );
    }
    return {
      release: true,
      kind,
      baseVersion: version,
      hotfix: false,
      hotfixOf: "",
      hotfixOfVersion: "",
      deploymentDestination: "Maven Central",
      frozenBranch: "",
      snapshotBranch: `embargoed/${plain}-INTERNAL-SNAPSHOT`,
      snapshotVersion: `${plain}-INTERNAL-SNAPSHOT`,
    };
  }

  if (HOTFIX.test(plain)) {
    throw new Error(
      `${refName} has the version ${version}, which is a hotfix already: an active embargoed branch has the version of the release that it fixes`,
    );
  }
  // A .0 version has a hotfix too (7.2.0.1), but only once its next release is the GA and not
  // a milestone or a release candidate. The milestones say, so the workflow decides it.
  const hotfix = `${plain}.1`;
  return {
    release: true,
    kind,
    baseVersion: `${hotfix}-SNAPSHOT`,
    hotfix: true,
    hotfixOf: `release/${plain}-SNAPSHOT`,
    hotfixOfVersion: plain,
    deploymentDestination: "Spring Enterprise",
    frozenBranch: refName.replace(/^embargoed\/active\//, "embargoed/frozen/"),
    snapshotBranch: `embargoed/${hotfix}-SNAPSHOT`,
    snapshotVersion: `${hotfix}-SNAPSHOT`,
  };
}

const OUTPUTS = {
  release: "release",
  kind: "kind",
  baseVersion: "base-version",
  hotfix: "hotfix",
  hotfixOf: "hotfix-of",
  hotfixOfVersion: "hotfix-of-version",
  deploymentDestination: "deployment-destination",
  frozenBranch: "frozen-branch",
  snapshotBranch: "snapshot-branch",
  snapshotVersion: "snapshot-version",
};

export async function main() {
  const refName = core.getInput("ref-name", { required: true });
  const version = core.getInput("version", { required: true });
  const result = plan({ refName, version });
  if (result.kind === "lts") {
    core.info(
      `${refName} is a long-term support embargoed branch: the release of ${version}, and the snapshot of it`,
    );
  } else if (result.kind === "frozen") {
    core.info(
      `${refName} is a frozen embargoed branch: the release of ${version}, and the internal snapshot of it`,
    );
  } else {
    core.info(
      `${refName} is an active embargoed branch: the hotfix ${result.baseVersion.replace("-SNAPSHOT", "")} of ${version}`,
    );
  }
  for (const [key, name] of Object.entries(OUTPUTS)) {
    if (key in result) {
      core.setOutput(name, String(result[key]));
    }
  }
}

if (isMain(import.meta.url)) {
  execute(main);
}
