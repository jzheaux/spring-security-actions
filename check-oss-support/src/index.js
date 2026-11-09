import * as core from "@actions/core";
import { execute, isMain, TitledError } from "./run.js";

const DEFAULT_API_URL = "https://api.spring.io";

/** The generation of a version: 7.0.9 and 7.0.9.1 are of 7.0.x. */
export function generationOf(version) {
  const match = /^(\d+)\.(\d+)\./.exec((version ?? "").trim());
  if (!match) {
    throw new Error(
      `"${version}" is not a version: expected <major>.<minor>.<patch>`,
    );
  }
  return `${match[1]}.${match[2]}.x`;
}

/**
 * The generations of a project from the Spring projects API
 * (GET <api>/projects/<project>/generations, a HAL list in _embedded.generations, each
 * with name, ossSupportEndDate and commercialSupportEndDate as YYYY-MM-DD or null).
 */
export async function readGenerations({ apiUrl, project }, { fetch }) {
  const url = `${apiUrl.replace(/\/$/, "")}/projects/${encodeURIComponent(project)}/generations`;
  let response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: "application/hal+json, application/json;q=0.9, */*;q=0.8",
      },
    });
  } catch (error) {
    throw new Error(`Reading ${url} failed: ${error.message}`);
  }
  if (!response.ok) {
    throw new Error(
      `Reading ${url} failed with ${response.status} ${response.statusText ?? ""}`.trim(),
    );
  }
  const body = await response.json();
  const generations = body?._embedded?.generations;
  if (!Array.isArray(generations)) {
    throw new Error(`${url} has no generations`);
  }
  return generations;
}

/**
 * Fails if the OSS support of the generation of the version ends before the date. An
 * embargoed fix of a generation is disclosed on that date (the release is made public),
 * so a generation that is not OSS any more by then is not frozen and active branches: it
 * is commercial, and has one embargoed/lts branch instead (embargoed/lts/<generation>, or the
 * one with a version of that major and minor, as plan-freeze finds it).
 *
 * The end date is the last day of support, so a release on that day is fine. A generation
 * with no end date has no end. It returns { generation, ossSupportEnd }.
 */
export async function run(
  { apiUrl = DEFAULT_API_URL, project, version, date, branch },
  { fetch },
) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) {
    throw new Error(`The date ${date} is not a date, expected YYYY-MM-DD`);
  }
  const generation = generationOf(version);
  const generations = await readGenerations({ apiUrl, project }, { fetch });
  const found = generations.find((g) => g.name === generation);
  if (!found) {
    throw new Error(
      `${project} has no generation ${generation} in the Spring projects API (${apiUrl})`,
    );
  }
  const ossSupportEnd = found.ossSupportEndDate ?? "";
  if (ossSupportEnd && ossSupportEnd < date) {
    throw new TitledError(
      `OSS support of ${generation} ended`,
      `OSS support of ${generation} ended on ${ossSupportEnd}, before the disclosure date ${date}${branch ? ` of ${branch}` : ""}: replace embargoed/frozen/${generation} and embargoed/active/${generation} with the embargoed/lts branch of the generation, which is for the generations that are commercial.`,
    );
  }
  return { generation, ossSupportEnd };
}

export async function main() {
  const result = await run(
    {
      apiUrl: core.getInput("api-url") || DEFAULT_API_URL,
      project: core.getInput("project", { required: true }),
      version: core.getInput("version", { required: true }),
      date: core.getInput("date", { required: true }),
      branch: core.getInput("branch"),
    },
    { fetch: globalThis.fetch },
  );
  core.setOutput("generation", result.generation);
  core.setOutput("oss-support-end", result.ossSupportEnd);
  core.info(
    `OSS support of ${result.generation} ${result.ossSupportEnd ? `ends on ${result.ossSupportEnd}` : "has no end"}, not before the disclosure date`,
  );
}

if (isMain(import.meta.url)) {
  execute(main);
}
