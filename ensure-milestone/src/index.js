import * as core from "@actions/core";
import { call, createOctokit, parseRepository } from "./octokit.js";
import { execute, isMain } from "./run.js";

// A milestone is due at noon UTC, which is the same day in every time zone.
const NOON = "T12:00:00Z";

/**
 * Makes sure that a repository has a milestone of a title, open or closed. If there is
 * none, it is created with the title, and the due date and the description if there are
 * any. The description is only for a milestone that is created: one that exists is not given it.
 * With a due date (YYYY-MM-DD), the milestone is due that day, at noon UTC: one that is due
 * another day, or has none, is changed, so that it follows the milestone that the date is of.
 * Without one, a milestone that exists is not changed. It returns { created, changed, url }.
 */
export async function run(
  { repository, milestone, dueDate = "", description = "" },
  { octokit },
) {
  if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
    throw new Error(`"${dueDate}" is not a date: expected YYYY-MM-DD`);
  }
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
  const found = milestones.find((m) => m.title === milestone);
  if (found) {
    const previous = found.due_on ? found.due_on.slice(0, 10) : "";
    if (!dueDate || previous === dueDate) {
      return { created: false, changed: false, url: found.html_url ?? "" };
    }
    await call(
      `Setting the due date of the milestone ${milestone} of ${repository}`,
      octokit.rest.issues.updateMilestone({
        owner,
        repo,
        milestone_number: found.number,
        due_on: `${dueDate}${NOON}`,
      }),
    );
    return {
      created: false,
      changed: true,
      previous,
      url: found.html_url ?? "",
    };
  }
  const { data } = await call(
    `Creating the milestone ${milestone} of ${repository}`,
    octokit.rest.issues.createMilestone({
      owner,
      repo,
      title: milestone,
      ...(description && { description }),
      ...(dueDate && { due_on: `${dueDate}${NOON}` }),
    }),
  );
  return { created: true, changed: false, url: data.html_url ?? "" };
}

export async function main() {
  const repository = core.getInput("repository", { required: true });
  const milestone = core.getInput("milestone", { required: true });
  const dueDate = core.getInput("due-date");
  const description = core.getInput("description");
  const octokit = createOctokit({ token: core.getInput("token") });
  const result = await run(
    { repository, milestone, dueDate, description },
    { octokit },
  );
  core.setOutput("created", String(result.created));
  core.setOutput("changed", String(result.changed));
  core.setOutput("milestone-url", result.url);
  if (result.created) {
    core.notice(
      `Created the milestone ${milestone} in ${repository}, ${dueDate ? `due ${dueDate}` : "with no due date"}`,
      { title: "Milestone created" },
    );
  } else if (result.changed) {
    core.notice(
      `The milestone ${milestone} of ${repository} was due ${result.previous || "on no date"} and is now due ${dueDate}, as the milestone that it follows`,
      { title: "Milestone due date" },
    );
  } else {
    core.info(`${repository} has the milestone ${milestone} already`);
  }
}

if (isMain(import.meta.url)) {
  execute(main);
}
