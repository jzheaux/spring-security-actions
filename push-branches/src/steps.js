import { escapeMarkdown } from "./summary.js";

/**
 * The subjects of the commits that the actions of this repository make. The workflow gives
 * three of them (the license, the version, the release), update-versions makes the others,
 * and merge-release makes the merge. A test checks that the actions still make them, so the
 * summary cannot read a commit wrong after one of them was changed.
 */
export const SUBJECTS = {
  merge: /^Merge (\S+) into (\S+)$/,
  license: /^Commercial changes for (\S+)$/,
  version: /^Set the version to (\S+)$/,
  release: /^Release (\S+)$/,
  dependency: /^Update (\S+) to (\S+)$/,
};

const issueOf = (commit) => /Closes gh-(\d+)/.exec(commit.body)?.[1];

/**
 * What the run did to build a branch, one sentence for each step, in the order that it did
 * it. It is read from the commits that were made on the branch after the pushed commit, so it
 * says what is really there, and from what the run knows of the steps that left no commit (a
 * merge that was skipped).
 *
 *   role      release or snapshot
 *   kind      frozen, active or lts
 *   commits   the commits made after the pushed commit, in order (commitsMadeAfter)
 *   merged    for a hotfix, what merge-release said for this branch: true, false, up-to-date
 *   basedOn   for a hotfix, the branch that this one is based on
 *   train     the name of the release train, if there was one
 *   link      a sha as a link to its commit
 */
export function describeSteps({
  role,
  kind,
  base,
  refName,
  commits,
  merged,
  basedOn,
  train,
  link,
}) {
  const steps = [
    `Started from the pushed commit ${link(base)}${refName ? ` of \`${refName}\`` : ""}.`,
  ];
  const hotfix = kind === "active";
  if (hotfix && merged === "false") {
    steps.push(
      `Skipped the merge: \`${basedOn}\` does not exist, so the hotfix ${role === "release" ? "release" : "snapshot"} is built from the active embargoed branch alone.`,
    );
  } else if (hotfix && merged === "up-to-date") {
    steps.push(`Merged nothing: \`${basedOn}\` is in the branch already.`);
  }
  for (let i = 0; i < commits.length; i++) {
    const commit = commits[i];
    const merge = SUBJECTS.merge.exec(commit.subject);
    const license = SUBJECTS.license.exec(commit.subject);
    const version =
      SUBJECTS.version.exec(commit.subject) ??
      SUBJECTS.release.exec(commit.subject);
    if (merge) {
      steps.push(
        `Merged \`${merge[1]}\` into it (${link(commit.sha)})${
          hotfix ? `: the hotfix ${role} is the ${role} plus the fixes` : ""
        }.`,
      );
    } else if (license) {
      steps.push(`Applied the commercial license (${link(commit.sha)}).`);
    } else if (version) {
      steps.push(`Set the version to \`${version[1]}\` (${link(commit.sha)}).`);
    } else if (SUBJECTS.dependency.test(commit.subject)) {
      const group = [commit];
      while (
        i + 1 < commits.length &&
        SUBJECTS.dependency.test(commits[i + 1].subject)
      ) {
        group.push(commits[++i]);
      }
      steps.push(dependencies(group, train, link));
    } else {
      steps.push(`${link(commit.sha)} ${escapeMarkdown(commit.subject)}`);
    }
  }
  return steps;
}

/** The step of a group of dependency updates, each with its commit and its issue. */
function dependencies(group, train, link) {
  const updates = group.map((commit) => {
    const [, name, version] = SUBJECTS.dependency.exec(commit.subject);
    return { commit, name, version, issue: issueOf(commit) };
  });
  const snapshots = updates.every(({ version }) =>
    version.endsWith("SNAPSHOT"),
  );
  const issues = updates.every(({ issue }) => issue);
  const none = updates.every(({ issue }) => !issue);
  const what = `${updates.length} ${updates.length === 1 ? "dependency" : "dependencies"}`;
  const items = updates
    .map(
      ({ commit, name, version, issue }) =>
        `${link(commit.sha)} (${escapeMarkdown(name)} ${escapeMarkdown(version)}${issue ? `, Closes gh-${issue}` : ""})`,
    )
    .join(", ");
  const from = train ? ` from train ${train}` : "";
  const issue = issues
    ? updates.length === 1
      ? ", with its issue"
      : ", each with its issue"
    : none
      ? ", with no issue"
      : "";
  return `Updated ${what}${snapshots ? " to snapshots" : ""}${from}${issue}: ${items}.`;
}
