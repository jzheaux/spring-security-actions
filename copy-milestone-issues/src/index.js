import * as core from "@actions/core";
import { call, createOctokit, parseRepository } from "./octokit.js";
import { TitledError, execute, isMain } from "./run.js";
import { addSummary, table } from "./summary.js";

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

const labelName = (label) => (typeof label === "string" ? label : label.name);

/**
 * Copies the issues and the pull requests of a milestone of the source repository to the
 * destination repository, as issues with the same title, labels, issue type, assignees and
 * milestone, and closed if the original is. Nothing else is copied: not the body, which can
 * name the source, and not the comments. Nothing is added to a copy either. The milestone
 * is never created: it has to exist in both repositories.
 *
 * - A label that the destination lacks is created, with the colour and the description that
 *   it has in the source.
 * - An assignee who cannot be assigned in the destination (GitHub drops them without an
 *   error) is left out, and the result says so.
 * - Each original gets a comment with the link to its copy, which is also what a later run
 *   reads: an original that has it is skipped, so a run can be repeated.
 * - With dryRun nothing is written: the result says what would be copied.
 *
 * It returns { copied, skipped, labelsToCreate, dropped, dryRun }: for every item that is
 * (or would be) copied { from, to, url, title, state, labels, assignees }, where `to` and
 * `url` are empty in a dry run; the skipped originals; the names of the labels that were
 * (or would be) created; and the assignees that were left out, with their issues.
 */
export async function run(
  { source, destination, milestone, dryRun = false },
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
      `${destination} has no milestone ${milestone}: it is not created, as it has to exist in both repositories`,
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

  // GitHub drops an assignee that cannot be assigned, silently: so they are all checked
  // first, and the ones that cannot be assigned are left out.
  const dropped = new Map();
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
        const issues = dropped.get(login) ?? [];
        issues.push(`${source}#${item.number}`);
        dropped.set(login, issues);
      }
    }
  }
  const assignable = (item) =>
    logins(item.assignees).filter((login) => checked.get(login.toLowerCase()));

  // the labels that the destination lacks are made like the ones of the source
  const existing = new Set(
    (
      await call(
        `Reading the labels of ${destination}`,
        octokit.paginate(octokit.rest.issues.listLabelsForRepo, {
          ...to,
          per_page: 100,
        }),
      )
    ).map((label) => label.name.toLowerCase()),
  );
  const missing = new Map();
  for (const item of pending) {
    for (const label of item.labels ?? []) {
      const name = labelName(label);
      if (
        !existing.has(name.toLowerCase()) &&
        !missing.has(name.toLowerCase())
      ) {
        missing.set(name.toLowerCase(), label);
      }
    }
  }
  const labelsToCreate = [...missing.values()].map(labelName);
  if (!dryRun) {
    for (const label of missing.values()) {
      const details = typeof label === "string" ? {} : label;
      await call(
        `Creating the label ${labelName(label)} in ${destination}`,
        octokit.rest.issues.createLabel({
          ...to,
          name: labelName(label),
          ...(details.color && { color: details.color }),
          ...(details.description && { description: details.description }),
        }),
      );
    }
  }

  const copied = [];
  for (const item of pending) {
    const original = `${source}#${item.number}`;
    const type = item.pull_request ? undefined : item.type?.name;
    const assignees = assignable(item);
    const labels = (item.labels ?? []).map(labelName);
    const record = {
      from: original,
      to: "",
      url: item.html_url ?? "",
      title: item.title,
      state: item.state,
      labels,
      assignees,
    };
    if (dryRun) {
      copied.push(record);
      continue;
    }
    const { data: copy } = await call(
      `Copying ${original} to ${destination}`,
      octokit.rest.issues.create({
        ...to,
        title: item.title,
        labels,
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
        `${copyName} has the assignees [${actual.join(", ")}], and ${original} has [${wanted.join(", ")}] that can be assigned`,
      );
    }
    copied.push({
      ...record,
      to: copyName,
      url: copy.html_url ?? "",
    });
    core.info(`Copied ${original} to ${copyName}`);
  }
  return {
    copied,
    skipped,
    labelsToCreate,
    dropped: [...dropped].map(([login, issues]) => ({ login, issues })),
    dryRun,
  };
}

const issueUrl = (repository, number) =>
  `https://github.com/${repository}/issues/${number}`;

/** `owner/repo#12` as a link to the issue on GitHub. */
function link(reference) {
  const [repository, number] = reference.split("#");
  return `[${reference}](${issueUrl(repository, number)})`;
}

const code = (names) => names.map((name) => `\`${name}\``).join(", ");

/**
 * The summary of a run: what was copied (or, in a dry run, what would be), with the link to
 * every original, the labels that were created, and the assignees that were left out.
 */
export function summaryOf({ source, destination, milestone }, result) {
  const { copied, skipped, labelsToCreate, dropped, dryRun } = result;
  const header = [
    "Original",
    ...(dryRun ? [] : ["Copy"]),
    "Title",
    "State",
    "Labels",
    "Assignees",
  ];
  const rows = copied.map((item) => [
    link(item.from),
    ...(dryRun ? [] : [link(item.to)]),
    item.title.replace(/\|/g, "\\|"),
    item.state,
    code(item.labels) || "none",
    item.assignees.join(", ") || "none",
  ]);
  const lines = [
    `### Issues of the milestone ${milestone}: ${source} to ${destination}${dryRun ? " (dry run)" : ""}`,
    "",
  ];
  if (copied.length > 0) {
    lines.push(
      dryRun ? "Would be copied:" : "Copied:",
      "",
      table(header, rows),
      "",
    );
  } else {
    lines.push(dryRun ? "Nothing would be copied." : "Nothing was copied.", "");
  }
  lines.push(
    `Labels ${dryRun ? "to create" : "created"} in ${destination}: ${code(labelsToCreate) || "none"}.`,
    "",
    dropped.length > 0
      ? `Assignees left out, as they cannot be assigned in ${destination}: ${dropped.map((d) => `${d.login} (${d.issues.map(link).join(", ")})`).join(", ")}.`
      : "Assignees left out: none.",
  );
  if (skipped.length > 0) {
    lines.push(
      "",
      `Copied already, and skipped: ${skipped.map((s) => link(s.from)).join(", ")}.`,
    );
  }
  return lines.join("\n");
}

export async function main() {
  const source = core.getInput("source-repository", { required: true });
  const destination = core.getInput("destination-repository", {
    required: true,
  });
  const milestone = core.getInput("milestone", { required: true });
  const dryRun = core.getInput("dry-run").trim().toLowerCase() === "true";
  const octokit = createOctokit({ token: core.getInput("token") });
  const input = { source, destination, milestone };
  const result = await run({ ...input, dryRun }, { octokit });
  addSummary(summaryOf(input, result));
  core.setOutput("copied", String(result.copied.length));
  core.setOutput("skipped", String(result.skipped.length));
  for (const item of result.skipped) {
    core.info(`Skipped ${item.from}: copied to ${destination}#${item.to}`);
  }
  core.notice(
    `${dryRun ? "Would copy" : "Copied"} ${result.copied.length} from ${source} to ${destination} for the milestone ${milestone}, and skipped ${result.skipped.length} that were copied already`,
    { title: dryRun ? "Issues to copy" : "Issues copied" },
  );
}

if (isMain(import.meta.url)) {
  execute(main);
}
