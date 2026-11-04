import * as core from "@actions/core";
import { parseBoolean } from "./inputs.js";
import { call, createOctokit, parseRepository } from "./octokit.js";
import { execute, isMain } from "./run.js";
import { addSummary } from "./summary.js";

const SNAPSHOT = "-SNAPSHOT";

// The milestones of a repository ("owner/repo"), all pages. A milestone has a title, a
// state and due_on (an ISO timestamp in UTC, or null). The state is open, closed or all.
function listMilestones(octokit, repository, state) {
  const { owner, repo } = parseRepository(repository);
  return call(
    `Reading the milestones of ${repository} (${state})`,
    octokit.paginate(octokit.rest.issues.listMilestones, {
      owner,
      repo,
      state,
      per_page: 100,
    }),
  );
}

// A new milestone, with a title and nothing else: it is open, and has no due date or description.
async function createMilestone(octokit, repository, title) {
  const { owner, repo } = parseRepository(repository);
  const { data } = await call(
    `Creating the milestone ${title} of ${repository}`,
    octokit.rest.issues.createMilestone({ owner, repo, title }),
  );
  return data;
}

/** The milestone exists, but has no due date: it carries what the summary links to. */
class NoDueDateError extends Error {
  constructor(message, milestone) {
    super(message);
    this.milestone = milestone;
  }
}

/** The milestone exists, but its description does not name a release train. */
class NoReleaseTrainError extends Error {
  constructor(message, milestone) {
    super(message);
    this.milestone = milestone;
  }
}

const SERVER = () =>
  (process.env.GITHUB_SERVER_URL || "https://github.com").replace(/\/+$/, "");

const KINDS = ["frozen", "active", "lts"];

const numbered = (steps) => steps.map((step, i) => `${i + 1}. ${step}`);

/**
 * The summary for a release that cannot join a release train yet, because its milestone
 * does not exist, has no due date, or (a long-term support version) does not name its train:
 * what to create or change, with links to do it. What correlates a milestone with a train
 * depends on the kind of the branch that is built:
 *
 * - frozen: the milestone is in the OSS repository, and its due date is the date of the train.
 * - lts: the milestone is in the commercial repository, and its description names the train
 *   (Release Train: 2026.11.19), as a due date cannot: it is the commercial general
 *   availability of the train, which the workflow sets. Only commercial versions name a train.
 * - active: a hotfix (7.0.1.1) is released from the commercial repository, and is in the train
 *   of the OSS version it fixes (7.0.1): the milestone of that version in the OSS repository
 *   gives the train, with its due date. The milestone of the hotfix needs to exist, and any due
 *   date will do, as the workflow sets it. The summary is for the OSS milestone (a version with
 *   three numbers) or for the milestone of the hotfix (four numbers).
 */
export function noTrainSummary({
  candidate,
  repository,
  milestone,
  kind = "frozen",
}) {
  if (!KINDS.includes(kind)) {
    throw new Error(`Unknown kind "${kind}": expected ${KINDS.join(", ")}`);
  }
  const create = `[create the milestone ${candidate}](${SERVER()}/${repository}/milestones/new)`;
  const edit = (text) => `[${text}](${milestone?.html_url}/edit)`;
  const lines = [`### ${candidate} is not in a release train`, ""];
  const finish = (...steps) => {
    lines.push("To add it to a release train:", ...numbered(steps), "");
    return lines.join("\n");
  };
  const again = "Run the workflow again.";

  if (kind === "lts") {
    lines.push(
      milestone
        ? `The description of the milestone ${candidate} of ${repository} does not name its release train.`
        : `${repository} has no milestone ${candidate}.`,
      "",
    );
    return finish(
      milestone
        ? `${edit("Edit the milestone")} and add a line \`Release Train: 2026.11.19\` to its description. The workflow sets its due date from the train.`
        : `${create} in ${repository}, and add a line \`Release Train: 2026.11.19\` to its description. The workflow sets its due date from the train.`,
      again,
    );
  }

  const trainDate = "the date of a release train (for example 2026-11-19)";
  const missing = milestone
    ? `The milestone ${candidate} of ${repository} has no due date.`
    : `${repository} has no milestone ${candidate}.`;
  // create the milestone, then give it a due date; or give the one that exists a due date
  const dueDate = milestone
    ? [`${edit("Set its due date")} to ${trainDate}.`]
    : [`${create} in ${repository}.`, `Set its due date to ${trainDate}.`];

  if (kind === "active" && /^\d+\.\d+\.\d+\.\d+$/.test(candidate)) {
    const fixed = candidate.slice(0, candidate.lastIndexOf("."));
    lines.push(
      missing,
      "",
      `The hotfix ${candidate} is in the release train of the OSS version ${fixed}: the train in which the milestone ${fixed} of the OSS repository is due.`,
      "",
    );
    return finish(
      `${milestone ? `${edit("Set its due date")} to any date` : `${create} in ${repository}`}. Any due date will do, because the workflow sets it to the commercial general availability of the train (for example 2026-12-24).`,
      again,
    );
  }
  if (kind === "active") {
    lines.push(
      missing,
      "",
      `A hotfix of ${candidate} is in the release train in which the milestone ${candidate} is due.`,
      "",
    );
    return finish(...dueDate, again);
  }
  lines.push(missing, "");
  return finish(...dueDate, again);
}

const isHotfix = (candidate) => /^\d+\.\d+\.\d+\.\d+$/.test(candidate);

/**
 * The summary for a milestone that was created because it did not exist. It has no due date
 * and names no release train, so what is to be set depends on the kind of the branch, as for
 * noTrainSummary. A hotfix milestone needs neither: its due date is set from the train of the
 * OSS version, so the summary only says so, and the release goes on.
 */
export function createdMilestoneSummary({
  candidate,
  repository,
  milestone,
  kind = "frozen",
}) {
  if (!KINDS.includes(kind)) {
    throw new Error(`Unknown kind "${kind}": expected ${KINDS.join(", ")}`);
  }
  const link = `[${candidate}](${milestone.html_url})`;
  const edit = (text) => `[${text}](${milestone.html_url}/edit)`;
  if (kind === "active" && isHotfix(candidate)) {
    const fixed = candidate.slice(0, candidate.lastIndexOf("."));
    return [
      `### Milestone ${candidate} created`,
      "",
      `The milestone ${link} was created in ${repository}. Its due date is set to the commercial general availability of the train of the OSS version ${fixed}.`,
      "",
    ].join("\n");
  }
  const what = kind === "lts" ? "no release train" : "no due date";
  const steps =
    kind === "lts"
      ? `${edit("Edit the milestone")} and add a line \`Release Train: 2026.11.19\` to its description. The workflow sets its due date from the train.`
      : `${edit("Set its due date")} to the date of a release train (for example 2026-11-19).`;
  return [
    `### ${candidate} is not in a release train yet`,
    "",
    `The milestone ${link} was created in ${repository}, with ${what}, so nothing was built.`,
    "",
    "To add it to a release train:",
    `1. ${steps}`,
    "2. Run the workflow again.",
    "",
  ].join("\n");
}

/**
 * The version a snapshot version is going to be released as, before looking at the
 * milestones: 7.0.1-SNAPSHOT gives 7.0.1. A snapshot version never carries a
 * milestone (M) or a release candidate (RC), so only numbers are accepted.
 */
export function candidateOf(snapshotVersion) {
  const version = (snapshotVersion ?? "").trim();
  if (!version.endsWith(SNAPSHOT)) {
    throw new Error(
      `"${version}" is not a snapshot version: it must end with ${SNAPSHOT}`,
    );
  }
  const candidate = version.slice(0, -SNAPSHOT.length);
  if (!/^\d+\.\d+\.\d+(\.\d+)?$/.test(candidate)) {
    throw new Error(
      `Cannot get a release version from "${version}": expected <major>.<minor>.<patch>[.<hotfix>]${SNAPSHOT}`,
    );
  }
  return candidate;
}

// A line of the description of a milestone that names its release train: "Release Train: 2026.10.22".
const TRAIN_LINE = /^[ \t]*release[ \t]+train[ \t]*:[ \t]*(.*?)[ \t]*$/gim;
const TRAIN_NAME = /^\d{4}\.\d{2}\.\d{2}$/;

/**
 * The release train that the description of a milestone names, with a line
 * `Release Train: 2026.10.22` (the key is not case sensitive): the name of its branch in the
 * release train repository. Empty if the description has no such line. A name that is not the
 * name of a branch of a train (YYYY.MM.DD), or two lines that name different trains, are errors.
 */
export function releaseTrainOf(description, title = "the milestone") {
  const names = [...(description ?? "").matchAll(TRAIN_LINE)].map((m) => m[1]);
  for (const name of names) {
    if (!TRAIN_NAME.test(name)) {
      throw new Error(
        `The description of ${title} names the release train "${name}", which is not the name of a train: expected YYYY.MM.DD, for example "Release Train: 2026.11.19"`,
      );
    }
  }
  const distinct = [...new Set(names)];
  if (distinct.length > 1) {
    throw new Error(
      `The description of ${title} names two release trains (${distinct.join(", ")}): it must name one`,
    );
  }
  return distinct[0] ?? "";
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The order of the releases of a version: its milestones, then its release candidates,
// then the version itself.
function releaseOrder(title, candidate) {
  const match = title.slice(candidate.length).match(/^-(M|RC)(\d+)$/);
  if (!match) {
    return [2, 0];
  }
  return [match[1] === "M" ? 0 : 1, Number(match[2])];
}

function byDueDateThenRelease(candidate) {
  return (a, b) => {
    // A milestone without a due date comes last.
    const dueA = a.due_on ? Date.parse(a.due_on) : Infinity;
    const dueB = b.due_on ? Date.parse(b.due_on) : Infinity;
    if (dueA !== dueB) {
      return dueA < dueB ? -1 : 1;
    }
    const [kindA, numberA] = releaseOrder(a.title, candidate);
    const [kindB, numberB] = releaseOrder(b.title, candidate);
    return kindA - kindB || numberA - numberB;
  };
}

/**
 * Works out the version a snapshot version is released as, and when, from the
 * milestones of a repository:
 *
 * - 7.0.1-SNAPSHOT is released as 7.0.1.
 * - 7.1.0-SNAPSHOT is a .0 version: it is released as one of its milestones
 *   (7.1.0-M1, 7.1.0-RC1) or as 7.1.0 itself. The open milestone with the earliest
 *   due date of those is next.
 *
 * The due date is a date in UTC (a milestone is due at noon UTC, so it is the same
 * day in every time zone). It fails if the milestone has no due date, unless
 * requireDueDate is false. If the milestone does not exist, it does not fail: it
 * returns { found: false, message }, and the caller decides what to do. With releaseOnly,
 * a .0 version whose next milestone is a milestone or a release candidate (7.2.0-RC1) is
 * not found either: only the release itself (7.2.0) is, as a hotfix is only made of that.
 */
export async function run(
  {
    snapshotVersion,
    milestoneRepository,
    requireDueDate = true,
    releaseOnly = false,
    requireReleaseTrain = false,
    createMissing = false,
    kind = "frozen",
  },
  { octokit },
) {
  const candidate = candidateOf(snapshotVersion);
  let milestone;
  let created = false;
  // A milestone that does not exist is created if told to, with a title and nothing else: no
  // due date, and no release train. Only a hotfix goes on with it, as it needs neither (its
  // train is the one of the OSS version). For any other, there is nothing to build until it is
  // in a train, so it ends as if it were not found, with a notice.
  const missing = async (message, exists = false) => {
    // a milestone that exists, but is closed, is not created again
    if (!createMissing || exists) {
      return { result: { found: false, candidate, message } };
    }
    const made = await createMilestone(octokit, milestoneRepository, candidate);
    if (kind === "active" && isHotfix(candidate)) {
      return { milestone: made };
    }
    return {
      result: {
        found: false,
        created: true,
        candidate,
        milestone: made,
        notice: "Milestone created",
        message: `Created the milestone ${candidate} in ${milestoneRepository}, which is not in a release train yet, so nothing is built`,
      },
    };
  };
  if (candidate.endsWith(".0")) {
    const pattern = new RegExp(`^${escapeRegExp(candidate)}(-(M|RC)\\d+)?$`);
    const open = await listMilestones(octokit, milestoneRepository, "open");
    const matching = open
      .filter((m) => pattern.test(m.title))
      .sort(byDueDateThenRelease(candidate));
    if (matching.length === 0) {
      const closed =
        createMissing &&
        (await listMilestones(octokit, milestoneRepository, "all")).some(
          (m) => m.title === candidate,
        );
      const outcome = await missing(
        `${milestoneRepository} has no open milestone for ${candidate}: expected ${candidate}, ${candidate}-M<n> or ${candidate}-RC<n>, so nothing is built`,
        closed,
      );
      if (outcome.result) {
        return outcome.result;
      }
      milestone = outcome.milestone;
      created = true;
    } else if (releaseOnly && matching[0].title !== candidate) {
      return {
        found: false,
        candidate,
        notice: "No release",
        message: `The next release of ${candidate} in ${milestoneRepository} is ${matching[0].title}, and not ${candidate}, which is the only one that has a hotfix, so nothing is built`,
      };
    }
    if (!created) {
      milestone = matching[0];
    }
  } else {
    const all = await listMilestones(octokit, milestoneRepository, "all");
    milestone = all.find((m) => m.title === candidate);
    if (!milestone) {
      const outcome = await missing(
        `${milestoneRepository} has no milestone ${candidate}, so nothing is built`,
      );
      if (outcome.result) {
        return outcome.result;
      }
      milestone = outcome.milestone;
      created = true;
    }
  }

  const dueDate = milestone.due_on
    ? new Date(milestone.due_on).toISOString().slice(0, 10)
    : "";
  if (!dueDate && requireDueDate) {
    throw new NoDueDateError(
      `The milestone ${milestone.title} of ${milestoneRepository} has no due date (set require-due-date to false to allow that)`,
      milestone,
    );
  }
  const releaseTrain = releaseTrainOf(
    milestone.description,
    `the milestone ${milestone.title} of ${milestoneRepository}`,
  );
  if (!releaseTrain && requireReleaseTrain) {
    throw new NoReleaseTrainError(
      `The description of the milestone ${milestone.title} of ${milestoneRepository} does not name its release train: add a line "Release Train: <name>", for example "Release Train: 2026.11.19" (set require-release-train to false to allow that)`,
      milestone,
    );
  }
  return {
    found: true,
    releaseVersion: milestone.title,
    dueDate,
    releaseTrain,
    milestoneUrl: milestone.html_url ?? "",
    created,
    milestone,
  };
}

export async function main() {
  const inputs = {
    snapshotVersion: core.getInput("snapshot-version", { required: true }),
    milestoneRepository: core.getInput("milestone-repository", {
      required: true,
    }),
    requireDueDate: parseBoolean(
      "require-due-date",
      core.getInput("require-due-date"),
      true,
    ),
    releaseOnly: parseBoolean(
      "release-only",
      core.getInput("release-only"),
      false,
    ),
    requireReleaseTrain: parseBoolean(
      "require-release-train",
      core.getInput("require-release-train"),
      false,
    ),
    kind: core.getInput("kind") || "frozen",
    createMissing: parseBoolean(
      "create-missing",
      core.getInput("create-missing"),
      false,
    ),
    failIfMissing: parseBoolean(
      "fail-if-missing",
      core.getInput("fail-if-missing"),
      true,
    ),
  };
  const octokit = createOctokit({ token: core.getInput("milestone-token") });
  let result;
  try {
    result = await run(inputs, { octokit });
  } catch (error) {
    if (
      error instanceof NoReleaseTrainError ||
      error instanceof NoDueDateError
    ) {
      addSummary(
        noTrainSummary({
          candidate: error.milestone.title,
          repository: inputs.milestoneRepository,
          milestone: error.milestone,
          kind: inputs.kind,
        }),
      );
    }
    throw error;
  }
  if (!result.found) {
    // a milestone that is there, but is not the release, is not one to add to a train, nor
    // a failure: there is only nothing to build
    if (result.created) {
      addSummary(
        createdMilestoneSummary({
          candidate: result.candidate,
          repository: inputs.milestoneRepository,
          milestone: result.milestone,
          kind: inputs.kind,
        }),
      );
    } else if (!result.notice) {
      addSummary(
        noTrainSummary({
          candidate: result.candidate,
          repository: inputs.milestoneRepository,
          kind: inputs.kind,
        }),
      );
    }
    if (inputs.failIfMissing && !result.notice) {
      throw new Error(result.message);
    }
    core.notice(result.message, { title: result.notice ?? "No milestone" });
    core.setOutput("found", "false");
    core.setOutput(
      "no-release",
      result.notice === "No release" ? "true" : "false",
    );
    core.setOutput("release-version", "");
    core.setOutput("due-date", "");
    core.setOutput("release-train", "");
    core.setOutput("milestone-url", "");
    return;
  }
  if (result.created) {
    addSummary(
      createdMilestoneSummary({
        candidate: result.releaseVersion,
        repository: inputs.milestoneRepository,
        milestone: result.milestone,
        kind: inputs.kind,
      }),
    );
  }
  const { releaseVersion, dueDate, releaseTrain, milestoneUrl } = result;
  core.info(
    `${inputs.snapshotVersion} is released as ${releaseVersion}, due ${dueDate || "on no date"}`,
  );
  core.setOutput("found", "true");
  core.setOutput("no-release", "false");
  core.setOutput("release-version", releaseVersion);
  core.setOutput("due-date", dueDate);
  core.setOutput("release-train", releaseTrain);
  core.setOutput("milestone-url", milestoneUrl);
}

if (isMain(import.meta.url)) {
  execute(main);
}
