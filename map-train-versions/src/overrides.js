// The overrides of the suffix of a snapshot: which project, or which version of it, gets
// -SNAPSHOT or -INTERNAL-SNAPSHOT whatever the workflow asks for.
//
//   spring-framework=-SNAPSHOT            every version of the project
//   spring-data-bom@2025.1.x=-SNAPSHOT    the versions of a generation of it
//   spring-framework@7.0.10.1=-INTERNAL-SNAPSHOT   one version of it (a hotfix too)
//
// One rule per line, or separated by commas. The version is the one of the project as the
// train lists it, and not the name of the train.

const SUFFIXES = ["-SNAPSHOT", "-INTERNAL-SNAPSHOT"];
const VERSION = /^\d+\.\d+\.\d+(?:\.\d+)?$/;
const GENERATION = /^\d+\.\d+\.x$/;

/**
 * Reads the rules. Throws, with the rule in the message, for one that cannot be read, one
 * with a suffix that is not a snapshot, one for a project that the train does not have, and
 * two rules for the same project and version.
 *
 * Returns [{ rule, project, version, suffix }], version is null for a whole project.
 */
export function parseOverrides(text, releaseVersions) {
  const seen = new Set();
  const overrides = [];
  for (const rule of (text ?? "")
    .split(/[\n,]/)
    .map((line) => line.trim())
    .filter(Boolean)) {
    const match = /^([^@=\s]+)(?:@([^=\s]+))?=(\S+)$/.exec(rule);
    if (!match) {
      throw new Error(
        `Cannot read the snapshot suffix override "${rule}": expected <project>=<suffix> or <project>@<version>=<suffix>`,
      );
    }
    const [, project, version = null, suffix] = match;
    if (!SUFFIXES.includes(suffix)) {
      throw new Error(
        `The snapshot suffix override "${rule}" has the suffix ${suffix}: it must be ${SUFFIXES.join(" or ")}`,
      );
    }
    if (
      version !== null &&
      !VERSION.test(version) &&
      !GENERATION.test(version)
    ) {
      throw new Error(
        `The snapshot suffix override "${rule}" has the version ${version}: expected one version (7.0.10 or 7.0.10.1) or a generation (7.0.x)`,
      );
    }
    if (releaseVersions && !Object.hasOwn(releaseVersions, project)) {
      throw new Error(
        `The snapshot suffix override "${rule}" is for ${project}, which is not a project of the train`,
      );
    }
    const key = `${project}@${version ?? ""}`;
    if (seen.has(key)) {
      throw new Error(
        `The snapshot suffix override for ${version ? `${project}@${version}` : project} is given twice`,
      );
    }
    seen.add(key);
    overrides.push({ rule, project, version, suffix });
  }
  return overrides;
}

/**
 * The most specific rule for a version of a project: the version itself, then its
 * generation, then the whole project. Undefined if there is none.
 */
export function findOverride(overrides, project, version, generation) {
  const of = overrides.filter((o) => o.project === project);
  return (
    of.find((o) => o.version === version) ??
    of.find((o) => o.version === generation) ??
    of.find((o) => o.version === null)
  );
}
