import * as core from "@actions/core";
import { call, createOctokit, parseRepository } from "./octokit.js";
import { TitledError, execute, isMain } from "./run.js";

/** The comment that an original gets: the link to its copy, and a marker that a run reads to know that it was copied. */
export function copiedComment(destination, number) {
  return `Copied to ${destination}#${number}.\n\n<!-- copied-to: ${destination}#${number} -->`;
}

/** The number of the copy that the comments of an original say, or undefined if it was not copied to the destination. */
function copyNumber(comments, destination) {
  const marker = new RegExp(
    `<!-- copied-to: ${destination.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}#(\\d+) -->`,
  );
  for (const comment of comments) {
    const match = marker.exec(comment.body ?? "");
    if (match) {
      return Number(match[1]);
    }
  }
  return undefined;
}

/**
 * Why a copy is closed. A pull request that was merged is completed, and one that was closed
 * without a merge is not planned. An issue keeps its reason, except for a duplicate: the issue
 * that it duplicates is not carried over, and a duplicate needs one, so it is not planned.
 */
export function closeReason(item) {
  if (item.pull_request) {
    return item.pull_request.merged_at ? "completed" : "not_planned";
  }
  return item.state_reason === "not_planned" ||
    item.state_reason === "duplicate"
    ? "not_planned"
    : "completed";
}

const logins = (users) => (users ?? []).map((user) => user.login);

async function findMilestone(octokit, repository, milestone) {
  const { owner, repo } = parseRepository(repository);
  const milestones = await call(
    `Reading the milestones of ${repository}`,
    octokit.paginate(octokit.rest.issues.listMilestones, {
      owner,
      repo,
      state: "all",
      per_page: 100,
    }),
  );
  return milestones.find((m) => m.title === milestone);
}

/**
 * Copies the issues and the pull requests of a milestone of the source repository to the
 * destination repository, as issues with the same title, body (unless omitBody), labels, issue
 * type, assignees and milestone, and closed if the original is. Nothing is added to a copy.
 * Each original gets a comment with the link to its copy, which is also what a later run reads:
 * an original that has it is skipped. Before anything is copied, every assignee has to be
 * assignable in the destination, as GitHub drops the ones that are not without an error.
 * It returns { copied: [{ from, to, url }], skipped: [{ from, to }] }.
 */
export async function run(
  { source, destination, milestone, omitBody = false },
  { octokit },
) {
  const from = parseRepository(source);
  const to = parseRepository(destination);
  if (source.toLowerCase() === destination.toLowerCase()) {
    throw new Error(`The source and the destination are both ${source}`);
  }
  const sourceMilestone = await findMilestone(octokit, source, milestone);
  if (!sourceMilestone) {
    throw new TitledError(
      "Milestone not found",
      `${source} has no milestone ${milestone}`,
    );
  }
  const destinationMilestone = await findMilestone(
    octokit,
    destination,
    milestone,
  );
  if (!destinationMilestone) {
    throw new TitledError(
      "Milestone not found",
      `${destination} has no milestone ${milestone}: create it first, for example with ensure-milestone`,
    );
  }

  const items = await call(
    `Reading the issues of the milestone ${milestone} of ${source}`,
    octokit.paginate(octokit.rest.issues.listForRepo, {
      ...from,
      milestone: sourceMilestone.number,
      state: "all",
      per_page: 100,
    }),
  );
  items.sort((a, b) => a.number - b.number);

  const skipped = [];
  const pending = [];
  for (const item of items) {
    const comments = item.comments
      ? await call(
          `Reading the comments of ${source}#${item.number}`,
          octokit.paginate(octokit.rest.issues.listComments, {
            ...from,
            issue_number: item.number,
            per_page: 100,
          }),
        )
      : [];
    const number = copyNumber(comments, destination);
    if (number) {
      skipped.push({ from: `${source}#${item.number}`, to: number });
    } else {
      pending.push(item);
    }
  }

  // GitHub drops an assignee that cannot be assigned, silently: so they are all checked first
  const unassignable = new Map();
  const checked = new Map();
  for (const item of pending) {
    for (const login of logins(item.assignees)) {
      const key = login.toLowerCase();
      if (!checked.has(key)) {
        try {
          await octokit.rest.issues.checkUserCanBeAssigned({
            ...to,
            assignee: login,
          });
          checked.set(key, true);
        } catch (error) {
          if (error.status !== 404) {
            throw new Error(
              `Checking that ${login} can be assigned in ${destination} failed with ${error.status} ${error.message}`,
            );
          }
          checked.set(key, false);
        }
      }
      if (!checked.get(key)) {
        unassignable.set(login, [
          ...(unassignable.get(login) ?? []),
          `${source}#${item.number}`,
        ]);
      }
    }
  }
  if (unassignable.size) {
    const lines = [...unassignable].map(
      ([login, numbers]) =>
        `${login} (${numbers.join(", ")}) cannot be assigned in ${destination}`,
    );
    throw new TitledError(
      "Assignees",
      `Nothing was copied, as GitHub would drop the assignees that cannot be assigned:\n${lines.join("\n")}`,
    );
  }

  const copied = [];
  for (const item of pending) {
    const original = `${source}#${item.number}`;
    const body = omitBody ? "" : (item.body ?? "");
    const type = item.pull_request ? undefined : item.type?.name;
    const assignees = logins(item.assignees);
    const { data: copy } = await call(
      `Copying ${original} to ${destination}`,
      octokit.rest.issues.create({
        ...to,
        title: item.title,
        ...(body && { body }),
        labels: (item.labels ?? []).map((label) =>
          typeof label === "string" ? label : label.name,
        ),
        assignees,
        milestone: destinationMilestone.number,
        ...(type && { type }),
      }),
    );
    const copyName = `${destination}#${copy.number}`;
    // the comment is the only record of the copy: it comes before anything else can fail
    await call(
      `Commenting on ${original} that it was copied to ${copyName}`,
      octokit.rest.issues.createComment({
        ...from,
        issue_number: item.number,
        body: copiedComment(destination, copy.number),
      }),
    );
    if (item.state === "closed") {
      await call(
        `Closing the copy ${copyName} of ${original}`,
        octokit.rest.issues.update({
          ...to,
          issue_number: copy.number,
          state: "closed",
          state_reason: closeReason(item),
        }),
      );
    }
    const wanted = assignees.map((login) => login.toLowerCase()).sort();
    const actual = logins(copy.assignees)
      .map((login) => login.toLowerCase())
      .sort();
    if (wanted.join() !== actual.join()) {
      throw new TitledError(
        "Assignees",
        `${copyName} has the assignees [${actual.join(", ")}], and ${original} has [${wanted.join(", ")}]`,
      );
    }
    copied.push({ from: original, to: copyName, url: copy.html_url ?? "" });
    core.info(`Copied ${original} to ${copyName}`);
  }
  return { copied, skipped };
}

export async function main() {
  const source = core.getInput("source-repository", { required: true });
  const destination = core.getInput("destination-repository", {
    required: true,
  });
  const milestone = core.getInput("milestone", { required: true });
  const omitBody = core.getBooleanInput("omit-body");
  const octokit = createOctokit({ token: core.getInput("token") });
  const { copied, skipped } = await run(
    { source, destination, milestone, omitBody },
    { octokit },
  );
  core.setOutput("copied", String(copied.length));
  core.setOutput("skipped", String(skipped.length));
  for (const item of skipped) {
    core.info(`Skipped ${item.from}: copied to ${destination}#${item.to}`);
  }
  core.notice(
    `Copied ${copied.length} from ${source} to ${destination} for the milestone ${milestone}, and skipped ${skipped.length} that were copied already`,
    { title: "Issues copied" },
  );
}

if (isMain(import.meta.url)) {
  execute(main);
}
