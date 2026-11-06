import * as core from "@actions/core";
import { execute, isMain } from "./run.js";

// <major>.<minor>.<patch>, a fourth number for a hotfix (7.0.1.1), and a milestone or a
// release candidate (-M1, -RC2) at the end.
const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?(?:-(?:M|RC)\d+)?$/;

/**
 * Works out what follows from a tag, which is the release version as it is (7.0.1, and
 * not v7.0.1): the version without its milestone or release candidate (7.1.0-RC2 is
 * the base version 7.1.0, which the snapshot version is made from), the generation that
 * it belongs to (7.0.x for 7.0.1 and for the hotfix 7.0.1.1), and whether it is a hotfix
 * (it has a fourth number). A tag that is not a version is an error.
 */
export function computeTagVersions(tag) {
  const releaseVersion = (tag ?? "").trim();
  const match = VERSION.exec(releaseVersion);
  if (!match) {
    throw new Error(
      `"${tag}" is not a tag of a version: expected <major>.<minor>.<patch>, with a fourth number for a hotfix, and -M<n> or -RC<n> for a milestone or a release candidate`,
    );
  }
  const [, major, minor, patch, hotfixNumber] = match;
  const base = [major, minor, patch, hotfixNumber].filter(Boolean).join(".");
  return {
    releaseVersion,
    baseVersion: base,
    generation: `${major}.${minor}.x`,
    hotfix: hotfixNumber !== undefined,
  };
}

export async function main() {
  const versions = computeTagVersions(core.getInput("tag", { required: true }));
  core.info(`release-version: ${versions.releaseVersion}`);
  core.info(`base-version: ${versions.baseVersion}`);
  core.info(`generation: ${versions.generation}`);
  core.info(`hotfix: ${versions.hotfix}`);
  core.setOutput("release-version", versions.releaseVersion);
  core.setOutput("base-version", versions.baseVersion);
  core.setOutput("generation", versions.generation);
  core.setOutput("hotfix", String(versions.hotfix));
}

if (isMain(import.meta.url)) {
  execute(main);
}
