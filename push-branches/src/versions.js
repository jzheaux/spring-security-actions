// A version of a release: 7.0.9, 7.0.9.1 (a hotfix), 7.2.0-M1 or 7.2.0-RC1.
const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?(?:-(M|RC)(\d+))?$/;

// A milestone comes before a release candidate, which comes before the release.
const STAGE = { M: 0, RC: 1 };
const RELEASE = 2;

/**
 * The parts of a version that decide its order, or undefined if it is not the version of a
 * release (a snapshot, a branch that is not a release).
 */
export function parseVersion(text) {
  const match = VERSION.exec(text ?? "");
  if (!match) {
    return undefined;
  }
  const [, major, minor, patch, hotfix, stage, number] = match;
  return [
    Number(major),
    Number(minor),
    Number(patch),
    Number(hotfix ?? 0),
    stage ? STAGE[stage] : RELEASE,
    Number(number ?? 0),
  ];
}

/** Negative if a comes before b, positive if after, 0 if they are the same version. */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) {
      return left[i] - right[i];
    }
  }
  return 0;
}

/**
 * The greatest of the candidates that is below the version: 7.0.8 for 7.0.9, and 7.0.9 for
 * 7.0.9.1. Undefined if there is none. A candidate that is not the version of a release is not
 * taken.
 */
export function previousVersion(version, candidates) {
  if (!parseVersion(version)) {
    return undefined;
  }
  return candidates
    .filter((candidate) => parseVersion(candidate))
    .filter((candidate) => compareVersions(candidate, version) < 0)
    .sort(compareVersions)
    .at(-1);
}
