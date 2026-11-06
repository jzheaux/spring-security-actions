import * as core from "@actions/core";
import { execute, isMain } from "./run.js";

const SUFFIX = "-commercial";

/**
 * The names that follow from the repository that runs the workflow. The embargoed
 * branches only exist in the commercial repository (spring-security-commercial), and the
 * project of the release train, and the OSS repository with the milestones and the issues
 * (spring-security), are named after it: its name without -commercial. The commercial
 * repository is that name with -commercial, so it is the repository itself when it runs
 * from the commercial one, and the commercial repository of the project when it runs from
 * the OSS one.
 */
export function nameRepositories(repository) {
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(repository ?? "");
  if (!match) {
    throw new Error(`${repository} is not a repository, expected owner/name`);
  }
  const [, owner, name] = match;
  const project = name.endsWith(SUFFIX) ? name.slice(0, -SUFFIX.length) : name;
  if (!project) {
    throw new Error(`${repository} has no name without ${SUFFIX}`);
  }
  return {
    owner,
    project,
    ossRepository: `${owner}/${project}`,
    commercialRepository: `${owner}/${project}${SUFFIX}`,
  };
}

export async function main() {
  const repository =
    core.getInput("repository") || process.env.GITHUB_REPOSITORY;
  const { owner, project, ossRepository, commercialRepository } =
    nameRepositories(repository);
  core.info(
    `${repository}: the project is ${project}, its OSS repository ${ossRepository} and its commercial repository ${commercialRepository}`,
  );
  core.setOutput("owner", owner);
  core.setOutput("project", project);
  core.setOutput("oss-repository", ossRepository);
  core.setOutput("commercial-repository", commercialRepository);
}

if (isMain(import.meta.url)) {
  execute(main);
}
