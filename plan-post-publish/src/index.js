import fs from "node:fs";
import path from "node:path";
import * as core from "@actions/core";
import { listGenerations, readGenerations } from "./generations.js";
import { call, createOctokit, parseRepository } from "./octokit.js";
import { TitledError, execute, isMain } from "./run.js";
import { addSummary, table } from "./summary.js";

export const DEFAULT_PLAN_FILE = "post-publish/plan.json";

/** Runs a request, and answers whether it found something: a 404 is "no", anything else fails. */
async function found(what, request) {
  try {
    await call(what, request);
    return true;
  } catch (error) {
    if (/failed with 404 /.test(error.message)) {
      return false;
    }
    throw error;
  }
}

async function findMilestone(octokit, repository, title) {
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
  const milestone = milestones.find((m) => m.title === title);
  return milestone
    ? { number: milestone.number, state: milestone.state }
    : undefined;
}

const branchExists = (octokit, repository, branch) =>
  found(
    `Looking for the branch ${branch} of ${repository}`,
    octokit.rest.repos.getBranch({ ...parseRepository(repository), branch }),
  );

const tagExists = (octokit, repository, tag) =>
  found(
    `Looking for the tag ${tag} of ${repository}`,
    octokit.rest.git.getRef({
      ...parseRepository(repository),
      ref: `tags/${tag}`,
    }),
  );

/** The `version=` of the gradle.properties of a branch, or undefined if it has none. */
async function branchVersion(octokit, repository, branch) {
  let response;
  try {
    response = await call(
      `Reading gradle.properties of ${branch} of ${repository}`,
      octokit.rest.repos.getContent({
        ...parseRepository(repository),
        path: "gradle.properties",
        ref: branch,
      }),
    );
  } catch (error) {
    if (/failed with 404 /.test(error.message)) {
      return undefined;
    }
    throw error;
  }
  const text = Buffer.from(response.data.content ?? "", "base64").toString(
    "utf8",
  );
  return /^version=(.*)$/m.exec(text)?.[1]?.trim();
}

/** "7.1" of 7.1.3-SNAPSHOT, 7.1.x and 7.1.0-RC1. */
const majorMinor = (version) => /^(\d+\.\d+)[.-]/.exec(`${version}-`)?.[1];

/**
 * The candidates for the branch of a tag, from `spring-versions` (the generations of the
 * Spring projects API): the OSS branches (7.0.x, 7.1.x, main) for an OSS release, and the
 * commercial (long-term support) generations, which are in embargoed/lts/<generation>, for a
 * long-term support one. Oldest first.
 */
export function candidatesOf(kind, generations, today) {
  const wanted = kind === "oss" ? "OSS" : "COMMERCIAL";
  return listGenerations(generations, today)
    .filter((g) => g.type === wanted)
    .map((g) => ({
      generation: g.generation,
      branch: kind === "oss" ? g.branch : `embargoed/lts/${g.generation}`,
    }));
}

/**
 * The branch that a tag is merged into, and the branches that it is merged forward
 * through. It is the candidate that is named after the generation of the tag (7.0.x) and,
 * if there is none, the candidate whose gradle.properties has a version of the same major
 * and minor as the tag (main at 7.2.0-SNAPSHOT for 7.2.0, or embargoed/lts/2.7.x at
 * 2021.2.9-SNAPSHOT for 2021.2.9). None, or more than one, is an error. The chain is that
 * candidate and every newer one.
 */
export async function resolveChain(
  { kind, generation, baseVersion, tag, ossRepository, commercialRepository },
  candidates,
  { octokit },
) {
  const repository = kind === "oss" ? ossRepository : commercialRepository;
  let index = candidates.findIndex((c) => c.generation === generation);
  if (index < 0) {
    const wanted = majorMinor(baseVersion);
    const matches = [];
    for (const [i, candidate] of candidates.entries()) {
      const version = await branchVersion(
        octokit,
        repository,
        candidate.branch,
      );
      if (version && majorMinor(version) === wanted) {
        matches.push({ i, branch: candidate.branch, version });
      }
    }
    if (matches.length !== 1) {
      throw new TitledError(
        "No branch for the tag",
        matches.length === 0
          ? `${tag} is in the generation ${generation}, which is no branch of ${repository} (${candidates.map((c) => c.branch).join(", ") || "none"}), and none of them has a version ${wanted}.x in gradle.properties: nothing was changed`
          : `${tag} could be merged into ${matches.map((m) => `${m.branch} (${m.version})`).join(" or ")}: nothing was changed`,
      );
    }
    index = matches[0].i;
  }
  return candidates.slice(index);
}

/**
 * Plans what happens after a release is made public, and changes nothing: it fails with
 * everything that stops it before any change is made.
 *
 * - The kind: oss if the OSS repository has the milestone of the tag, else hotfix if the
 *   version has a fourth number, else lts (commercial).
 * - The issues are copied only for oss, and only if the commercial repository has the milestone
 *   too (the milestones are never created). The other cases are skipped, and said.
 * - The branches to delete: release/<version> and the snapshot branch, which has
 *   -INTERNAL-SNAPSHOT for oss and -SNAPSHOT for the others.
 * - The merges (none for a hotfix, which never comes back into the branches of its generation):
 *   the tag has to exist, in OSS for oss and in the commercial repository for lts, and the
 *   chain of branches is worked out (each OSS one needs its frozen and active branch).
 *
 * It returns { plan, notices }, the notices being what is to be logged: { level, title, message }.
 */
export async function plan(
  {
    releaseVersion,
    baseVersion,
    generation,
    hotfix,
    ossRepository,
    commercialRepository,
    project,
    apiUrl,
    today = new Date().toISOString().slice(0, 10),
  },
  { octokit, fetch },
) {
  const tag = releaseVersion;
  const oss = await findMilestone(octokit, ossRepository, tag);
  const commercial = await findMilestone(octokit, commercialRepository, tag);
  const kind = oss ? "oss" : hotfix ? "hotfix" : "lts";
  const notices = [];

  let copy = false;
  let copyReason;
  if (kind === "oss" && commercial) {
    copy = true;
    copyReason = `the milestone ${tag} exists in ${ossRepository} (#${oss.number}) and in ${commercialRepository} (#${commercial.number})`;
  } else if (kind === "oss") {
    copyReason = `${ossRepository} has the milestone ${tag} (#${oss.number}), and ${commercialRepository} has none, so there is nothing to copy`;
    notices.push({
      level: "warning",
      title: "No commercial milestone",
      message: `${copyReason}: the issues are not copied`,
    });
  } else if (commercial) {
    copyReason = `the milestone ${tag} is only in ${commercialRepository} (#${commercial.number}), so it is not an OSS release and its issues are not copied`;
    notices.push({
      level: "info",
      title: "Not an OSS release",
      message: `${copyReason}`,
    });
  } else {
    copyReason = `neither ${ossRepository} nor ${commercialRepository} has the milestone ${tag}`;
    notices.push({
      level: "warning",
      title: "No milestone",
      message: `${copyReason}: the issues are not copied`,
    });
  }

  const snapshotVersion = `${baseVersion}${kind === "oss" ? "-INTERNAL-SNAPSHOT" : "-SNAPSHOT"}`;
  const releaseBranch = `release/${releaseVersion}`;
  const snapshotBranch = `embargoed/${snapshotVersion}`;

  let merge = null;
  if (kind !== "hotfix") {
    const repository = kind === "oss" ? ossRepository : commercialRepository;
    const problems = [];
    if (!(await tagExists(octokit, repository, tag))) {
      throw new TitledError(
        "Tag not found",
        `${repository} has no tag ${tag}, so there is nothing to merge: nothing was changed`,
      );
    }
    const generations = await readGenerations({ apiUrl, project }, { fetch });
    const candidates = candidatesOf(kind, generations, today);
    const chain = await resolveChain(
      {
        kind,
        generation,
        baseVersion,
        tag,
        ossRepository,
        commercialRepository,
      },
      candidates,
      { octokit },
    );
    const branches = [];
    for (const candidate of chain) {
      const entry = {
        generation: candidate.generation,
        branch: candidate.branch,
      };
      if (kind === "oss") {
        entry.frozen = `embargoed/frozen/${candidate.branch}`;
        entry.active = `embargoed/active/${candidate.branch}`;
        for (const name of [entry.frozen, entry.active]) {
          if (!(await branchExists(octokit, commercialRepository, name))) {
            problems.push(`${commercialRepository} has no branch ${name}`);
          }
        }
        if (!(await branchExists(octokit, ossRepository, candidate.branch))) {
          problems.push(`${ossRepository} has no branch ${candidate.branch}`);
        }
      } else if (
        !(await branchExists(octokit, commercialRepository, candidate.branch))
      ) {
        problems.push(
          `${commercialRepository} has no branch ${candidate.branch}`,
        );
      }
      branches.push(entry);
    }
    if (problems.length > 0) {
      throw new TitledError(
        "Branches missing",
        `The merge of ${tag} needs branches that do not exist, and nothing was changed:\n- ${problems.join("\n- ")}`,
      );
    }
    merge = {
      kind,
      tagRepository: repository,
      branches,
    };
  }

  return {
    plan: {
      tag,
      releaseVersion,
      baseVersion,
      generation,
      hotfix,
      kind,
      ossRepository,
      commercialRepository,
      milestones: { oss: oss ?? null, commercial: commercial ?? null },
      copy,
      copyReason,
      snapshotVersion,
      releaseBranch,
      snapshotBranch,
      deleteBranches: [releaseBranch, snapshotBranch],
      merge,
    },
    notices,
  };
}

const KINDS = {
  oss: "OSS release",
  hotfix: "Hotfix",
  lts: "Long-term support release",
};

/** The summary of the plan, which is the head of the summary of the run. */
export function summaryOf(plan, dryRun) {
  const lines = [
    `### ${plan.tag}: Post Publish${dryRun ? " (dry run)" : ""}`,
    "",
    `${KINDS[plan.kind]}: ${plan.copyReason}.`,
    `Branches to delete: ${plan.deleteBranches.map((b) => `\`${b}\``).join(", ")}`,
  ];
  if (plan.merge) {
    const rows = plan.merge.branches.map((b) => [
      `\`${b.branch}\``,
      b.frozen ? `\`${b.frozen}\`, \`${b.active}\`` : "",
    ]);
    lines.push(
      "",
      `The tag \`${plan.tag}\` of ${plan.merge.tagRepository} is merged into \`${plan.merge.branches[0].branch}\`, and forward:`,
      "",
      table(["Branch", "Frozen and active"], rows),
    );
  } else {
    lines.push(
      "",
      "A hotfix is not merged: it never comes back into the branches of its generation.",
    );
  }
  return lines.join("\n");
}

export async function main() {
  const dryRun = core.getInput("dry-run").trim().toLowerCase() === "true";
  const octokit = createOctokit({ token: core.getInput("token") });
  const { plan: result, notices } = await plan(
    {
      releaseVersion: core.getInput("release-version", { required: true }),
      baseVersion: core.getInput("base-version", { required: true }),
      generation: core.getInput("generation", { required: true }),
      hotfix: core.getInput("hotfix").trim().toLowerCase() === "true",
      ossRepository: core.getInput("oss-repository", { required: true }),
      commercialRepository: core.getInput("commercial-repository", {
        required: true,
      }),
      project: core.getInput("project", { required: true }),
      apiUrl: core.getInput("api-url"),
    },
    { octokit, fetch },
  );
  for (const { level, title, message } of notices) {
    if (level === "warning") {
      core.warning(message, { title });
    } else {
      core.info(message);
    }
  }
  const planFile =
    core.getInput("plan-file") ||
    path.join(process.env.RUNNER_TEMP ?? process.cwd(), DEFAULT_PLAN_FILE);
  fs.mkdirSync(path.dirname(planFile), { recursive: true });
  fs.writeFileSync(planFile, `${JSON.stringify(result, null, 2)}\n`);
  addSummary(summaryOf(result, dryRun));
  core.setOutput("plan-file", planFile);
  core.setOutput("kind", result.kind);
  core.setOutput("copy", String(result.copy));
  core.setOutput("merge", result.merge ? result.merge.kind : "none");
  core.setOutput("snapshot-version", result.snapshotVersion);
  core.setOutput("delete-branches", result.deleteBranches.join("\n"));
  core.info(`${result.tag} is a ${KINDS[result.kind]}`);
}

if (isMain(import.meta.url)) {
  execute(main);
}
