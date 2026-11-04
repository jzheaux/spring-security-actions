import * as core from "@actions/core";
import { call, createOctokit, parseRepository } from "./octokit.js";
import { execute, isMain } from "./run.js";

/**
 * Makes sure that a repository has a milestone of a title: an open or a closed one is
 * enough, and is not changed. If there is none, it is created with the title and nothing
 * else: no due date, and no description. It returns { created, url }.
 */
export async function run({ repository, milestone }, { octokit }) {
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
    return { created: false, url: found.html_url ?? "" };
  }
  const { data } = await call(
    `Creating the milestone ${milestone} of ${repository}`,
    octokit.rest.issues.createMilestone({ owner, repo, title: milestone }),
  );
  return { created: true, url: data.html_url ?? "" };
}

export async function main() {
  const repository = core.getInput("repository", { required: true });
  const milestone = core.getInput("milestone", { required: true });
  const octokit = createOctokit({ token: core.getInput("token") });
  const result = await run({ repository, milestone }, { octokit });
  core.setOutput("created", String(result.created));
  core.setOutput("milestone-url", result.url);
  if (result.created) {
    core.notice(
      `Created the milestone ${milestone} in ${repository}, with no due date`,
      { title: "Milestone created" },
    );
  } else {
    core.info(`${repository} has the milestone ${milestone} already`);
  }
}

if (isMain(import.meta.url)) {
  execute(main);
}
