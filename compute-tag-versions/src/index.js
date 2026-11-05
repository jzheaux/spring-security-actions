import * as core from "@actions/core";
import { execute, isMain } from "./run.js";

/**
 * Works out the versions of a tag. A leading v is not part of the release version (v7.0.1
 * releases 7.0.1). The snapshot version is that release version, without its milestone or
 * release candidate (-M1, -RC2), and with -SNAPSHOT: 7.1.0-RC2 is followed by 7.1.0-SNAPSHOT.
 */
export function computeTagVersions(tag) {
  const releaseVersion = (tag ?? "").trim().replace(/^v/, "");
  if (!releaseVersion) {
    throw new Error(`${tag} is not a tag to take a version from`);
  }
  const base = releaseVersion.replace(/-(?:M|RC)\d+$/, "");
  return { releaseVersion, snapshotVersion: `${base}-SNAPSHOT` };
}

export async function main() {
  const { releaseVersion, snapshotVersion } = computeTagVersions(
    core.getInput("tag", { required: true }),
  );
  core.info(`release-version: ${releaseVersion}`);
  core.info(`snapshot-version: ${snapshotVersion}`);
  core.setOutput("release-version", releaseVersion);
  core.setOutput("snapshot-version", snapshotVersion);
}

if (isMain(import.meta.url)) {
  execute(main);
}
