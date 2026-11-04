import { gitTry } from "./git.js";
import {
  commitsMadeAfter,
  commitsNotIn,
  countCommits,
  resolve,
} from "./commits.js";
import { describeSteps } from "./steps.js";
import { commitLink, escapeMarkdown, repositoryUrl } from "./summary.js";
import { parseVersion, previousVersion } from "./versions.js";

/** The commits that a list shows, then "and N more" with a link to the compare view. */
export const LIST_LIMIT = 50;

const isRelease = (branch) => branch.startsWith("release/");

/**
 * What the commits of a branch are compared with, to list the ones that OSS lacks:
 *
 * - a hotfix is compared with the OSS version that it is based on (the tag 7.0.9 for 7.0.9.1).
 *   Until that release is public there is no such tag, and it is compared with the branch that
 *   it is based on (release/7.0.9, or embargoed/7.0.9-INTERNAL-SNAPSHOT for the snapshot)
 * - the other branches are compared with the branch of the OSS repository of their generation
 *   (7.0.x)
 * - if that cannot be done (OSS has no such branch, or could not be read), or if the run
 *   was not told where OSS is, with the pushed commit: the commits that the run made.
 *
 * It returns { gitRef, commandRef, heading, oss }: the ref that git is given, the ref as a
 * clone has it (for the command that the summary prints), the heading of the list, and
 * whether the clone needs OSS for it.
 */
export function compareWith({
  directory,
  role,
  kind,
  remote,
  base,
  oss,
  basedOn,
}) {
  const pushed = {
    gitRef: base,
    commandRef: base.slice(0, 10),
    oss: false,
  };
  const configured = Boolean(oss.url);
  const unreadable = oss.error ? `OSS could not be read: ${oss.error}` : "";

  if (kind === "active") {
    if (oss.tagRef) {
      return {
        gitRef: oss.tagRef,
        commandRef: oss.tag,
        heading: `**Commits not in OSS \`${oss.tag}\`**`,
        oss: true,
      };
    }
    const why =
      unreadable || (oss.tag ? `OSS ${oss.tag} is not public yet` : "");
    const branchRef = basedOn && `refs/remotes/${remote}/${basedOn}`;
    if (branchRef && resolve(directory, branchRef)) {
      return {
        gitRef: branchRef,
        commandRef: `${remote}/${basedOn}`,
        heading: `**Commits not in OSS**${
          why
            ? ` (${why}, so compared with \`${basedOn}\`, the branch it is based on)`
            : ` (compared with \`${basedOn}\`, the branch it is based on)`
        }`,
        oss: false,
      };
    }
    return {
      ...pushed,
      heading: `**Commits not in OSS** (${why || "OSS is not known"}${basedOn ? `, and \`${basedOn}\` does not exist` : ""}, so these are the commits that the run made on the pushed commit)`,
    };
  }

  if (oss.branchRef) {
    return {
      gitRef: oss.branchRef,
      commandRef: `oss/${oss.branch}`,
      heading: `**Commits not in OSS \`${oss.branch}\`**`,
      oss: true,
    };
  }
  if (!configured) {
    return { ...pushed, heading: "**Commits on the pushed commit**" };
  }
  return {
    ...pushed,
    heading: `**Commits not in OSS** (${unreadable || `OSS has no branch \`${oss.branch}\``}, so these are the commits that the run made on the pushed commit)`,
  };
}

/**
 * The release before a version: the greatest below it among the tags (OSS has them all, as
 * the release is public) and the release branches of the repository that is checked out
 * (release/7.0.8), as a clone has them. Undefined if there is none.
 */
export function previousRelease({ directory, remote, version }) {
  const found = new Map();
  const note = (candidate, gitRef, commandRef, rank) => {
    if (parseVersion(candidate) && !(found.get(candidate)?.rank <= rank)) {
      found.set(candidate, { gitRef, commandRef, rank });
    }
  };
  const refs = gitTry(
    directory,
    "for-each-ref",
    "--format=%(refname)",
    "refs/oss-tags",
    "refs/tags",
    `refs/remotes/${remote}/release`,
  ).stdout.split("\n");
  for (const ref of refs.filter(Boolean)) {
    let match;
    if ((match = /^refs\/oss-tags\/(.+)$/.exec(ref))) {
      note(match[1], ref, match[1], 0);
    } else if ((match = /^refs\/tags\/(.+)$/.exec(ref))) {
      note(match[1], ref, match[1], 1);
    } else if ((match = /^refs\/remotes\/[^/]+\/release\/(.+)$/.exec(ref))) {
      note(match[1], ref, `${remote}/release/${match[1]}`, 2);
    }
  }
  const previous = previousVersion(version, [...found.keys()]);
  if (!previous) {
    return undefined;
  }
  const { gitRef, commandRef, rank } = found.get(previous);
  return { version: previous, gitRef, commandRef, oss: rank === 0 };
}

/**
 * Everything that the summary says about the branches that were pushed, read from the
 * repository: how each was created, the commits that OSS lacks, and what the release has since
 * the one before it. The branches are in the order they are built in: the snapshot, then the release.
 */
export function collectReport({
  directory,
  remote,
  pushed,
  base,
  refName,
  kind,
  train,
  oss,
  snapshotOf,
  releaseOf,
  merged,
}) {
  const sorted = [...pushed].sort(
    (a, b) => Number(isRelease(a.branch)) - Number(isRelease(b.branch)),
  );
  const sections = sorted.map(({ branch, version }) => {
    const role = isRelease(branch) ? "release" : "snapshot";
    const basedOn = role === "release" ? releaseOf : snapshotOf;
    const compare = compareWith({
      directory,
      role,
      kind,
      remote,
      base,
      oss,
      basedOn,
    });
    const commits = commitsNotIn(directory, compare.gitRef, branch);
    const after = commitsMadeAfter(directory, base, branch);
    const section = {
      branch,
      version,
      role,
      compare,
      commits,
      compareSha: resolve(directory, compare.gitRef),
      steps: { role, kind, base, refName, commits: after, basedOn, train },
      merged: role === "release" ? merged.release : merged.snapshot,
    };
    if (role === "release") {
      const previous = previousRelease({ directory, remote, version });
      if (previous) {
        section.since = {
          ...previous,
          sha: resolve(directory, previous.gitRef),
          commits: countCommits(directory, previous.gitRef, branch, {
            merges: false,
          }),
          all: countCommits(directory, previous.gitRef, branch, {
            merges: true,
          }),
        };
      }
    }
    return section;
  });
  return { sections, base, remote, oss, kind };
}

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** The lines of the section of a branch: how it was created, its commits, and its commands. */
export function renderSection(section, { remote, cell }) {
  const repository = repositoryUrl();
  const lines = [
    `#### ${cell(section.branch)}`,
    "",
    "**How it was created**",
    "",
  ];
  describeSteps({
    ...section.steps,
    merged: section.merged,
    link: commitLink,
  }).forEach((step, i) => lines.push(`${i + 1}. ${step}`));

  lines.push("", section.compare.heading, "");
  if (section.commits.length === 0) {
    lines.push("None.");
  }
  for (const commit of section.commits.slice(0, LIST_LIMIT)) {
    lines.push(`- ${commitLink(commit.sha)} ${escapeMarkdown(commit.subject)}`);
  }
  const more = section.commits.length - LIST_LIMIT;
  if (more > 0) {
    const text = `and ${more} more`;
    lines.push(
      repository && section.compareSha
        ? `- [${text}](${repository}/compare/${section.compareSha}...${encodeURI(section.branch)})`
        : `- ${text}`,
    );
  }
  lines.push(
    "",
    "```shell",
    `git log --oneline --no-merges --reverse ${section.compare.commandRef}..${remote}/${section.branch}`,
    "```",
  );

  if (section.since) {
    const { version, commits, all, sha, commandRef } = section.since;
    const merges = all - commits;
    const compare =
      repository && sha
        ? `: [compare view](${repository}/compare/${sha}...${encodeURI(section.branch)})`
        : "";
    lines.push(
      "",
      "**All changes in this release**",
      "",
      `${plural(commits, "commit")} since ${version}${merges > 0 ? ` (${all} with the ${plural(merges, "merge commit")})` : ""}${compare}`,
      "",
      "```shell",
      `git log --oneline --no-merges ${commandRef}..${remote}/${section.branch}`,
      "```",
    );
  }
  return lines;
}

/**
 * The commands that get a clone ready for the ones of the summary: OSS as a remote, if a command
 * uses it, and the branches that were pushed.
 */
export function setupCommands(report) {
  const { sections, oss, remote } = report;
  const lines = [];
  const usesOss =
    sections.some(({ compare, since }) => compare.oss || since?.oss) && oss.url;
  if (usesOss) {
    const branch = sections.some(({ compare }) =>
      compare.commandRef.startsWith("oss/"),
    )
      ? ` ${oss.branch}`
      : "";
    lines.push(
      `git remote add oss ${oss.url}`,
      `git fetch oss${branch} --tags`,
    );
  }
  lines.push(`git fetch ${remote}`);
  return { lines, usesOss: Boolean(usesOss) };
}
