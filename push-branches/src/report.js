import { gitTry } from "./git.js";
import {
  commitsMadeAfter,
  commitsNotIn,
  countCommits,
  oursMerges,
  resolve,
} from "./commits.js";
import { describeSteps } from "./steps.js";
import {
  COMMERCIAL_REMOTE,
  OSS_REMOTE,
  commitLink,
  escapeMarkdown,
  repositoryUrl,
} from "./summary.js";
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
 * - a long-term support branch (commercial, with no OSS release) is compared with the release
 *   before it (`previous`, see previousRelease), 5.8.29 for 5.8.30
 * - the other branches are compared with the branch of the OSS repository of their generation
 *   (7.0.x)
 * - if that cannot be done (OSS has no such branch, or could not be read), or if the run
 *   was not told where OSS is, with the pushed commit: the commits that the run made.
 *
 * It returns { gitRef, commandRef, heading, oss }: the ref that git is given, the ref as a
 * clone has it (for the command that the summary prints), the heading of the list, and
 * whether the clone needs OSS for it.
 */
export function compareWith(args) {
  const comparison = chooseComparison(args);
  return {
    ...comparison,
    heading: `${comparison.heading} (omits commits merged with -s ours)`,
  };
}

function chooseComparison({
  directory,
  role,
  kind,
  remote,
  base,
  oss,
  basedOn,
  previous,
}) {
  const pushed = {
    gitRef: base,
    commandRef: base.slice(0, 10),
    oss: false,
  };
  // the release that a hotfix fixes: 7.0.9 for 7.0.9.1
  const fixed = oss.tag || /\d+\.\d+\.\d+/.exec(basedOn ?? "")?.[0];
  const fixes = fixed ? `\`${fixed}\`` : "the release it fixes";
  const configured = Boolean(oss.url);
  const unreadable = oss.error ? `OSS could not be read: ${oss.error}` : "";

  if (kind === "lts") {
    if (previous) {
      return {
        gitRef: previous.gitRef,
        commandRef: previous.commandRef,
        heading: `**Commits not in the previous release \`${previous.version}\`**`,
        oss: previous.oss,
      };
    }
    return {
      ...pushed,
      heading:
        "**Commits not in the previous release** (there is none, so these are the commits that the run made on the pushed commit)",
    };
  }

  if (kind === "active") {
    if (oss.tagRef) {
      return {
        gitRef: oss.tagRef,
        commandRef: oss.tag,
        heading: `**Commits not in ${fixes}**`,
        oss: true,
      };
    }
    const why =
      unreadable || (oss.tag ? `OSS ${oss.tag} is not public yet` : "");
    const branchRef = basedOn && `refs/remotes/${remote}/${basedOn}`;
    if (branchRef && resolve(directory, branchRef)) {
      return {
        gitRef: branchRef,
        commandRef: `${COMMERCIAL_REMOTE}/${basedOn}`,
        heading: `**Commits not in ${fixes}**${
          why
            ? ` (${why}, so compared with \`${basedOn}\`, the branch it is based on)`
            : ` (compared with \`${basedOn}\`, the branch it is based on)`
        }`,
        oss: false,
      };
    }
    return {
      ...pushed,
      heading: `**Commits not in ${fixes}** (${why || "OSS is not known"}${basedOn ? `, and \`${basedOn}\` does not exist` : ""}, so these are the commits that the run made on the pushed commit)`,
    };
  }

  if (oss.branchRef) {
    return {
      gitRef: oss.branchRef,
      commandRef: `${OSS_REMOTE}/${oss.branch}`,
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
      note(match[1], ref, `${COMMERCIAL_REMOTE}/release/${match[1]}`, 2);
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
  const releaseVersion = pushed.find(({ branch }) =>
    isRelease(branch),
  )?.version;
  const previous = releaseVersion
    ? previousRelease({ directory, remote, version: releaseVersion })
    : undefined;
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
      previous,
    });
    const ours = oursMerges(directory, compare.gitRef, branch);
    const commits = commitsNotIn(directory, compare.gitRef, branch, ours);
    const after = commitsMadeAfter(directory, base, branch);
    const section = {
      branch,
      version,
      role,
      compare,
      commits,
      ours,
      compareSha: resolve(directory, compare.gitRef),
      steps: { role, kind, base, refName, commits: after, basedOn, train },
      merged: role === "release" ? merged.release : merged.snapshot,
    };
    if (role === "release") {
      if (previous) {
        const sinceOurs = oursMerges(directory, previous.gitRef, branch);
        section.since = {
          ...previous,
          sha: resolve(directory, previous.gitRef),
          ours: sinceOurs,
          commits: countCommits(directory, previous.gitRef, branch, {
            merges: false,
            ours: sinceOurs,
          }),
          all: countCommits(directory, previous.gitRef, branch, {
            merges: true,
            ours: sinceOurs,
          }),
        };
      }
    }
    return section;
  });
  return { sections, base, remote, oss, kind };
}

/**
 * The git log command of the summary. With `-s ours` merges in the range it leaves out what
 * they merged in, as the list does (it still prints the merges themselves).
 */
function logCommand(flags, range, ours) {
  if (ours.length === 0) {
    return `git log ${flags} ${range}`;
  }
  return `git log ${flags} $(for m in $(git rev-list --merges ${range}); do git diff --quiet $m^1 $m && echo "^$m^2"; done) ${range}`;
}

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** The lines of the section of a branch: how it was created, its commits, and its commands. */
export function renderSection(section, { cell }) {
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
    logCommand(
      "--oneline --reverse",
      `${section.compare.commandRef}..${COMMERCIAL_REMOTE}/${section.branch}`,
      section.ours,
    ),
    "```",
  );

  if (section.since) {
    const { version, commits, all, sha, commandRef, ours } = section.since;
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
      logCommand(
        "--oneline --no-merges",
        `${commandRef}..${COMMERCIAL_REMOTE}/${section.branch}`,
        ours,
      ),
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
  const { sections, oss } = report;
  const lines = [];
  const usesOss =
    sections.some(({ compare, since }) => compare.oss || since?.oss) && oss.url;
  if (usesOss) {
    const branch = sections.some(({ compare }) =>
      compare.commandRef.startsWith(`${OSS_REMOTE}/`),
    )
      ? ` ${oss.branch}`
      : "";
    lines.push(
      `git remote add ${OSS_REMOTE} ${oss.url}`,
      `git fetch ${OSS_REMOTE}${branch} --tags`,
    );
  }
  const repository = repositoryUrl();
  if (repository) {
    lines.unshift(`git remote add ${COMMERCIAL_REMOTE} ${repository}.git`);
  }
  lines.push(`git fetch ${COMMERCIAL_REMOTE}`);
  return { lines, usesOss: Boolean(usesOss) };
}
