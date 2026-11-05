import * as core from "@actions/core";
import { call, createOctokit, parseRepository } from "./octokit.js";
import { execute, isMain } from "./run.js";

/**
 * The title of the issue of an update. It is not an input: the issue of an update is
 * found by its title, so every run must write the same one.
 */
export function issueTitle(dependency, version) {
  return `Update ${dependency} to ${version}`;
}

// What an issue of an update is called: the title that issueTitle writes.
const TITLE = /^Update (\S+) to (\S+)$/;

/** A list of labels, separated by commas or lines, without the empty ones. */
export function parseLabels(text) {
  return (text ?? "")
    .split(/[,\n]/)
    .map((label) => label.trim())
    .filter(Boolean);
}

/**
 * The updates as a list in the order of the names, from an object from the name to the
 * version, or to { version } (what map-train-versions and update-versions write).
 */
export function updatesOf(versions) {
  if (!versions || typeof versions !== "object" || Array.isArray(versions)) {
    throw new Error(
      "The versions must be an object from the name of a version to its new version",
    );
  }
  return Object.keys(versions)
    .sort()
    .map((dependency) => {
      const value = versions[dependency];
      const version = typeof value === "string" ? value : value?.version;
      if (!version || typeof version !== "string") {
        throw new Error(`The update of ${dependency} has no version`);
      }
      return { dependency, version };
    });
}

// The issues of a milestone, open and closed. A pull request is an issue too for GitHub,
// and is not what we are looking for.
async function listIssues(octokit, target, milestone, number) {
  const issues = await call(
    `Reading the issues of the milestone ${milestone} of ${target.owner}/${target.repo}`,
    octokit.paginate(octokit.rest.issues.listForRepo, {
      ...target,
      milestone: String(number),
      state: "all",
      per_page: 100,
    }),
  );
  return issues.filter((issue) => !issue.pull_request);
}

const pause = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * Makes sure that every update has an issue in the milestone of a repository: the issue
 * that has its title in that milestone is the one of the update, open or closed, and
 * only if there is none, one is created, without a body. With close, it is closed at
 * once: for a hotfix the commit of the update is made already, so there is nothing left
 * to do for it. Without it, it is left open for its commit to close. A run that is done
 * again does not make another.
 *
 * An issue of an update (its title is that of one, and it has the labels) that is in the
 * milestone, and is not one of the updates, is not in the release train any more: it gets
 * a comment that says so, and is taken out of the milestone.
 *
 * It returns the updates with the number of their issue, and whether it existed, and
 * the issues that were taken out of the milestone.
 *
 * GitHub lists a new issue a few seconds after it is created (2 to 5 seconds, measured).
 * A run that comes right after another one, after a cancelled run for example, would not
 * see its issues, and make them again. So after it has created issues, the action waits
 * until the list has them, up to attempts times intervalMs, and warns if it has not.
 */
export async function ensureIssues(
  { repository, milestone, versions, labels = [], type = "", close = true },
  {
    octokit,
    log = () => {},
    warn = log,
    sleep = pause,
    intervalMs = 2000,
    attempts = 15,
  },
) {
  const updates = updatesOf(versions);
  const target = parseRepository(repository);
  if (!milestone) {
    throw new Error("The input milestone is required");
  }

  const milestones = await call(
    `Reading the milestones of ${repository}`,
    octokit.paginate(octokit.rest.issues.listMilestones, {
      ...target,
      state: "all",
      per_page: 100,
    }),
  );
  const found = milestones.find((m) => m.title === milestone);
  if (!found) {
    throw new Error(`${repository} has no milestone ${milestone}`);
  }

  const existing = await listIssues(octokit, target, milestone, found.number);

  const issues = {};
  const wanted = new Set();
  const createdNumbers = [];
  for (const { dependency, version } of updates) {
    const title = issueTitle(dependency, version);
    wanted.add(title);
    // More than one with the same title is not meant to be: take an open one, and else
    // the first.
    const same = existing
      .filter((issue) => issue.title === title)
      .sort((a, b) => a.number - b.number);
    const issue = same.find((i) => i.state === "open") ?? same[0];
    if (issue) {
      issues[dependency] = {
        version,
        issue: issue.number,
        existed: true,
      };
      log(`${dependency} ${version}: issue ${issue.number} exists`);
      continue;
    }
    const { data: created } = await call(
      `Creating the issue "${title}" in ${repository}`,
      octokit.rest.issues.create({
        ...target,
        title,
        milestone: found.number,
        ...(labels.length > 0 && { labels }),
        ...(type && { type }),
      }),
    );
    if (close) {
      await call(
        `Closing the issue #${created.number} of ${repository}`,
        octokit.rest.issues.update({
          ...target,
          issue_number: created.number,
          state: "closed",
          state_reason: "completed",
        }),
      );
    }
    issues[dependency] = {
      version,
      issue: created.number,
      existed: false,
    };
    createdNumbers.push(created.number);
    log(
      `${dependency} ${version}: issue ${created.number} created${close ? " and closed" : ""}`,
    );
  }

  if (createdNumbers.length > 0) {
    let listed = false;
    for (let attempt = 0; attempt < attempts && !listed; attempt++) {
      const numbers = new Set(
        (await listIssues(octokit, target, milestone, found.number)).map(
          (issue) => issue.number,
        ),
      );
      listed = createdNumbers.every((number) => numbers.has(number));
      if (!listed) {
        await sleep(intervalMs);
      }
    }
    if (!listed) {
      warn(
        `The issues ${createdNumbers.join(", ")} are not in the list of ${repository} after ${(attempts * intervalMs) / 1000} seconds: a run that comes right now may create them again`,
      );
    }
  }
  const removed = [];
  for (const issue of existing) {
    if (wanted.has(issue.title) || !TITLE.test(issue.title)) {
      continue;
    }
    const names = (issue.labels ?? []).map((l) =>
      typeof l === "string" ? l : l.name,
    );
    if (!labels.every((label) => names.includes(label))) {
      continue;
    }
    await call(
      `Commenting on the issue #${issue.number} of ${repository}`,
      octokit.rest.issues.createComment({
        ...target,
        issue_number: issue.number,
        body: `Removed from the milestone ${milestone} because \`${issue.title.replace(TITLE, "$1 $2")}\` was not found in the release train on the latest run.`,
      }),
    );
    await call(
      `Taking the issue #${issue.number} of ${repository} out of the milestone ${milestone}`,
      octokit.rest.issues.update({
        ...target,
        issue_number: issue.number,
        milestone: null,
      }),
    );
    removed.push({ issue: issue.number, title: issue.title });
    log(
      `${issue.title}: issue ${issue.number} is not in the train, removed from the milestone`,
    );
  }
  return { issues, removed };
}

/**
 * The updates to make, from the issues that ensureIssues returns, as update-versions takes
 * them: an object from the name to { version, issue }.
 */
export function updatesToMake(issues) {
  return Object.fromEntries(
    Object.entries(issues).map(([dependency, { version, issue }]) => [
      dependency,
      { version, issue },
    ]),
  );
}

export async function main() {
  let versions;
  try {
    versions = JSON.parse(core.getInput("versions", { required: true }));
  } catch (error) {
    throw new Error(`The input versions is not JSON: ${error.message}`);
  }
  const close = core.getInput("close") !== "false";
  const octokit = createOctokit({ token: core.getInput("token") });
  const { issues, removed } = await ensureIssues(
    {
      repository: core.getInput("repository", { required: true }),
      milestone: core.getInput("milestone", { required: true }),
      versions,
      labels: parseLabels(core.getInput("labels")),
      type: core.getInput("type"),
      close,
    },
    {
      octokit,
      log: (line) => core.info(line),
      warn: (line) => core.warning(line),
    },
  );
  const all = Object.values(issues);
  core.info(
    `${all.length} issues: ${all.filter((i) => !i.existed).length} created${close ? " and closed" : ""}, ${all.filter((i) => i.existed).length} there already, ${removed.length} removed from the milestone`,
  );
  for (const { issue, title } of removed) {
    core.notice(
      `"${title}" (#${issue}) is not in the release train any more: removed from the milestone`,
      { title: "Removed from the milestone" },
    );
  }
  core.setOutput("issues", JSON.stringify(issues));
  core.setOutput("updates", JSON.stringify(updatesToMake(issues)));
  core.setOutput("removed", JSON.stringify(removed));
  core.setOutput("count", String(all.length));
}

if (isMain(import.meta.url)) {
  execute(main);
}
