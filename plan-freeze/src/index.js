import fs from "node:fs";
import path from "node:path";
import * as core from "@actions/core";
import { git, gitTry } from "./git.js";
import { call, createOctokit, parseRepository } from "./octokit.js";
import { execute, isMain, TitledError } from "./run.js";
import {
  candidateOf,
  hotfixOf,
  nextVersion,
  releaseVersionOf,
} from "./versions.js";

export const DEFAULT_PLAN_FILE = "code-freeze/plan.json";

const VERSION_LINE = /^version=([^\r\n]*)/m;

/** The milestones of a repository, all of them (open and closed). */
export function listMilestones(octokit, repository) {
  const { owner, repo } = parseRepository(repository);
  return call(
    `Reading the milestones of ${repository}`,
    octokit.paginate(octokit.rest.issues.listMilestones, {
      owner,
      repo,
      state: "all",
      per_page: 100,
    }),
  );
}

/** Whether a ref names a commit. */
function exists(directory, ref) {
  return gitTry(directory, "cat-file", "-e", `${ref}^{commit}`).code === 0;
}

/** The version of gradle.properties on a ref: undefined if the ref or the line is missing. */
function readVersion(directory, ref) {
  if (!exists(directory, ref)) {
    return undefined;
  }
  const shown = gitTry(directory, "show", `${ref}:gradle.properties`);
  if (shown.code !== 0) {
    return undefined;
  }
  return VERSION_LINE.exec(shown.stdout)?.[1];
}

/**
 * Makes the OSS repository a remote of the clone of the commercial repository, and fetches
 * its branches, as refs/remotes/<remote>/<branch>. They are only read here. The credentials
 * are the ones that the checkout of the commercial repository stored, for the same host.
 */
export function addOssRemote({ directory, remote, url }) {
  const known = gitTry(directory, "remote", "get-url", remote);
  if (known.code === 0 && known.stdout !== url) {
    throw new Error(
      `The remote ${remote} is ${known.stdout} already, and not ${url}`,
    );
  }
  if (known.code !== 0) {
    git(directory, "remote", "add", remote, url);
  }
  git(
    directory,
    "fetch",
    "--quiet",
    "--no-tags",
    remote,
    `+refs/heads/*:refs/remotes/${remote}/*`,
  );
}

/**
 * Plans a code freeze, and changes nothing but the remote of the OSS repository that it
 * fetches. It looks at every branch to freeze and says what is to be done: the version it
 * is bumped to, and the releases (release/<version>) that are to be marked ready first. It
 * collects every reason that stops the freeze, and does not stop at the first.
 *
 * - An OSS branch (7.0.x, main) has the frozen and the active embargoed branch of its
 *   generation, in the commercial repository. The three have one version.
 * - A long-term support generation (6.5.x) has one branch, embargoed/lts/6.5.x.
 * - A release is built from the branch: release/7.0.5 from the frozen branch (it is the release
 *   of the OSS branch too), release/7.0.5.1 from the active branch if it has changes that the
 *   frozen one lacks (the hotfix), release/6.5.11 from a long-term support branch. Each must
 *   exist and have joined the release train. One that is ready already is not marked ready again.
 */
export async function planFreeze(
  {
    directory,
    project,
    hostRepository,
    ossRepository,
    ossUrl,
    ossBranches,
    ltsGenerations,
    train,
    trainFound,
    trainDocument,
    commercialRemote = "origin",
    ossRemote = "oss",
  },
  { listMilestones: readMilestones },
) {
  if (!hostRepository.endsWith("-commercial")) {
    throw new TitledError(
      "Not a commercial repository",
      `The code freeze runs in the commercial repository of a project (its name ends with -commercial), and ${hostRepository} does not: the OSS repository is that name without -commercial, and they would be one and the same. Nothing was done.`,
    );
  }
  if (ossRepository === hostRepository) {
    throw new TitledError(
      "Not a commercial repository",
      `The OSS repository ${ossRepository} is the repository that runs the freeze. Nothing was done.`,
    );
  }
  addOssRemote({ directory, remote: ossRemote, url: ossUrl });

  const problems = [];
  const oss = [];
  const lts = [];
  const releases = new Map();
  const ossMilestones = await readMilestones(ossRepository);
  const commercialMilestones =
    ltsGenerations.length > 0 ? await readMilestones(hostRepository) : [];
  const titles = (milestones) => milestones.map((m) => m.title);

  const release = (version, builtFrom, of) => {
    const entry = releases.get(version) ?? {
      version,
      branch: `release/${version}`,
      builtFrom,
      of: [],
      alreadyReady: false,
    };
    entry.of.push(...of);
    releases.set(version, entry);
  };

  for (const branch of ossBranches) {
    const frozen = `embargoed/frozen/${branch}`;
    const active = `embargoed/active/${branch}`;
    const refs = {
      [branch]: `refs/remotes/${ossRemote}/${branch}`,
      [frozen]: `refs/remotes/${commercialRemote}/${frozen}`,
      [active]: `refs/remotes/${commercialRemote}/${active}`,
    };
    const versions = {};
    let missing = false;
    for (const [name, ref] of Object.entries(refs)) {
      const where =
        name === branch ? ossRepository : "the commercial repository";
      if (!exists(directory, ref)) {
        problems.push(`${name} does not exist in ${where}`);
        missing = true;
      } else if ((versions[name] = readVersion(directory, ref)) === undefined) {
        problems.push(`${name} has no version=... in gradle.properties`);
        missing = true;
      }
    }
    if (missing) {
      continue;
    }
    const current = versions[branch];
    if (new Set(Object.values(versions)).size > 1) {
      problems.push(
        `${branch}, ${frozen} and ${active} must have one version, and have ${Object.entries(
          versions,
        )
          .map(([name, v]) => `${v} (${name})`)
          .join(", ")}`,
      );
      continue;
    }
    let candidate;
    try {
      candidate = candidateOf(current);
    } catch (error) {
      problems.push(`${branch}: ${error.message}`);
      continue;
    }
    const next = nextVersion(current, titles(ossMilestones));
    oss.push({
      generation: branch,
      branch,
      frozen,
      active,
      current,
      next,
      bump: next !== current,
    });

    const releaseVersion = releaseVersionOf(candidate, ossMilestones);
    if (!releaseVersion) {
      problems.push(
        `${branch} (${current}) has no open milestone in ${ossRepository}, one of ${candidate}, ${candidate}-M<n> and ${candidate}-RC<n>, so there is no release to mark ready`,
      );
      continue;
    }
    release(releaseVersion, frozen, [branch, frozen]);
    const hotfix = hotfixOf(candidate, releaseVersion);
    const differs =
      gitTry(directory, "diff", "--quiet", `${refs[frozen]}...${refs[active]}`)
        .code !== 0;
    if (hotfix && differs) {
      release(hotfix, active, [active]);
    }
  }

  for (const generation of ltsGenerations) {
    const branch = `embargoed/lts/${generation}`;
    const ref = `refs/remotes/${commercialRemote}/${branch}`;
    if (!exists(directory, ref)) {
      problems.push(`${branch} does not exist in the commercial repository`);
      continue;
    }
    const current = readVersion(directory, ref);
    if (current === undefined) {
      problems.push(`${branch} has no version=... in gradle.properties`);
      continue;
    }
    let candidate;
    try {
      candidate = candidateOf(current);
    } catch (error) {
      problems.push(`${branch}: ${error.message}`);
      continue;
    }
    const next = nextVersion(current, titles(commercialMilestones));
    lts.push({
      generation,
      branch,
      current,
      next,
      bump: next !== current,
    });
    const releaseVersion = releaseVersionOf(candidate, commercialMilestones);
    if (!releaseVersion) {
      problems.push(
        `${branch} (${current}) has no open milestone in ${hostRepository}, one of ${candidate}, ${candidate}-M<n> and ${candidate}-RC<n>, so there is no release to mark ready`,
      );
      continue;
    }
    release(releaseVersion, branch, [branch]);
  }

  for (const entry of releases.values()) {
    if (
      !exists(directory, `refs/remotes/${commercialRemote}/${entry.branch}`)
    ) {
      problems.push(
        `${entry.branch} does not exist in the commercial repository: it is built from ${entry.builtFrom} when that branch is pushed, so the freeze has to wait for it`,
      );
      continue;
    }
    if (!trainFound) {
      problems.push(
        `${entry.branch} cannot be marked ready: the release train ${train} has not been created`,
      );
      continue;
    }
    const hashes =
      trainDocument?.releases?.[project]?.[entry.version]?.["commit-hashes"] ??
      {};
    if (hashes.ready) {
      // marked ready already: nothing to do for it, and the branch is bumped all the same
      entry.alreadyReady = true;
    } else if (!hashes.joined) {
      problems.push(
        `${entry.branch} has not joined the release train ${train}: join it (the release workflow does that when ${entry.builtFrom} is pushed), or leave ${entry.of[0]} out of the branches to freeze`,
      );
    }
  }

  return {
    project,
    hostRepository,
    ossRepository,
    train,
    oss,
    lts,
    releases: [...releases.values()],
    problems,
  };
}

/** The problems of a plan as one message. */
export function describeProblems(problems) {
  return `The code freeze cannot go ahead, and nothing was changed. ${problems.length === 1 ? "Problem" : `${problems.length} problems`}:\n- ${problems.join("\n- ")}`;
}

export async function main() {
  const planFile =
    core.getInput("plan-file") ||
    path.join(process.env.RUNNER_TEMP ?? process.cwd(), DEFAULT_PLAN_FILE);
  const hostRepository =
    core.getInput("host-repository") || process.env.GITHUB_REPOSITORY || "";
  const ossRepository = core.getInput("oss-repository", { required: true });
  const serverUrl = (
    process.env.GITHUB_SERVER_URL || "https://github.com"
  ).replace(/\/$/, "");
  const trainFound = core.getInput("train-found") !== "false";
  let trainDocument = {};
  if (trainFound) {
    const file = core.getInput("train-file", { required: true });
    try {
      trainDocument = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      throw new Error(
        `The train file ${file} cannot be read as JSON: ${error.message}`,
      );
    }
  }
  const list = (name) =>
    core
      .getInput(name)
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  const octokit = createOctokit({ token: core.getInput("token") });
  const plan = await planFreeze(
    {
      directory: core.getInput("path") || ".",
      project: core.getInput("project", { required: true }),
      hostRepository,
      ossRepository,
      ossUrl: core.getInput("oss-url") || `${serverUrl}/${ossRepository}.git`,
      ossBranches: list("oss-branches"),
      ltsGenerations: list("lts-branches"),
      train: core.getInput("train", { required: true }),
      trainFound,
      trainDocument,
    },
    { listMilestones: (repository) => listMilestones(octokit, repository) },
  );
  fs.mkdirSync(path.dirname(planFile), { recursive: true });
  fs.writeFileSync(planFile, `${JSON.stringify(plan, null, 2)}\n`);
  core.setOutput("plan-file", planFile);
  for (const entry of plan.oss) {
    core.info(
      `${entry.branch}: ${entry.current} to ${entry.next}${entry.bump ? "" : " (no commit)"}`,
    );
  }
  for (const entry of plan.lts) {
    core.info(
      `${entry.branch}: ${entry.current} to ${entry.next}${entry.bump ? "" : " (no commit)"}`,
    );
  }
  for (const entry of plan.releases) {
    core.info(
      entry.alreadyReady
        ? `${entry.branch} is ready already (${entry.of.join(", ")})`
        : `${entry.branch} is to be marked ready (${entry.of.join(", ")})`,
    );
  }
  if (plan.problems.length > 0) {
    throw new TitledError(
      "Code freeze stopped",
      describeProblems(plan.problems),
    );
  }
}

if (isMain(import.meta.url)) {
  execute(main);
}
