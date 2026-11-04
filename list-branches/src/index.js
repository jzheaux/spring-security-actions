import * as core from "@actions/core";
import { execute, isMain } from "./run.js";

const DEFAULT_API_URL = "https://api.spring.io";

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

/** [major, minor] of a generation, 7.1.x gives [7, 1]. */
function numbersOf(generation) {
  const match = /^(\d+)\.(\d+)\.x$/.exec(generation);
  if (!match) {
    throw new Error(
      `"${generation}" is not a generation: expected <major>.<minor>.x`,
    );
  }
  return [Number(match[1]), Number(match[2])];
}

const byGeneration = (a, b) => {
  const [majorA, minorA] = numbersOf(a.generation);
  const [majorB, minorB] = numbersOf(b.generation);
  return majorA - majorB || minorA - minorB;
};

/**
 * What `spring-versions` shows, in the order of the generations (oldest first). A generation
 * is supported while its commercial support has not ended (a generation with no end date has
 * none): it is OSS while its OSS support has not ended either, and commercial after that. The
 * branch of a generation is its name, except for the newest OSS generation, which is main.
 *
 * Each is { type: "OSS" | "COMMERCIAL", generation, branch }.
 */
export function listGenerations(generations, today) {
  const supported = generations
    .map((g) => ({
      generation: g.name,
      ossSupportEnd: g.ossSupportEndDate ?? null,
      commercialSupportEnd: g.commercialSupportEndDate ?? null,
    }))
    .filter(
      (g) => g.commercialSupportEnd !== null && g.commercialSupportEnd >= today,
    )
    .map((g) => ({
      ...g,
      type:
        g.ossSupportEnd !== null && g.ossSupportEnd >= today
          ? "OSS"
          : "COMMERCIAL",
    }))
    .sort(byGeneration);
  const newestOss = supported.filter((g) => g.type === "OSS").at(-1);
  return supported.map(({ type, generation }) => ({
    type,
    generation,
    branch:
      type === "OSS" && generation === newestOss.generation
        ? "main"
        : generation,
  }));
}

/** The entries of a list that is separated by commas, without the blanks around them. */
export function parseList(text) {
  return (text ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Checks an override of the branches of one kind, and returns it (the entries, which are
 * branches: 7.1.x or main for OSS, and the generation for a commercial one):
 *
 * - each is a branch of the discovered ones of that kind (an OSS branch is not a long-term
 *   support one, and the other way round),
 * - there are no duplicates, and the order is the one of the versions, oldest first,
 * - it is a run of the discovered branches with no gap: a generation in the middle that is
 *   left out would get no merge, and the next one would be merged from the one before it.
 *
 * It lists every problem, not only the first.
 */
export function checkOverride({ name, kind, entries, discovered, other }) {
  const problems = [];
  const names = discovered.map((g) => g.branch);
  if (entries.length === 0) {
    return { problems: [`${name} is empty`] };
  }
  for (const entry of entries) {
    if (!names.includes(entry)) {
      const otherKind = other.some((g) => g.branch === entry);
      problems.push(
        otherKind
          ? `${entry} in ${name} is a ${kind === "OSS" ? "commercial (long-term support)" : "OSS"} generation, not a ${kind === "OSS" ? "OSS" : "commercial"} one`
          : `${entry} in ${name} is not a ${kind === "OSS" ? "OSS" : "commercial"} generation of the project (they are ${names.join(", ") || "none"})`,
      );
    }
  }
  const duplicates = entries.filter((e, i) => entries.indexOf(e) !== i);
  for (const duplicate of new Set(duplicates)) {
    problems.push(`${duplicate} is twice in ${name}`);
  }
  if (problems.length > 0) {
    return { problems };
  }
  const positions = entries.map((e) => names.indexOf(e));
  const ascending = positions.every((p, i) => i === 0 || p > positions[i - 1]);
  if (!ascending) {
    problems.push(
      `${name} (${entries.join(", ")}) is not in the order of the versions, oldest first (${names.join(", ")}): a branch is merged into the next one, never the other way round`,
    );
    return { problems };
  }
  const first = positions[0];
  const last = positions.at(-1);
  if (last - first + 1 !== entries.length) {
    const skipped = names
      .slice(first, last + 1)
      .filter((n) => !entries.includes(n));
    problems.push(
      `${name} (${entries.join(", ")}) skips ${skipped.join(", ")}, which is in the middle of the chain: it would get no merge. Leave out the oldest or the newest branches, and not one in the middle`,
    );
  }
  return { problems };
}

/**
 * The branches to freeze. Without an override, all that were discovered; with one, the
 * override, after it was checked. It fails, with every problem, if it is wrong.
 *
 * It returns { oss, lts } as lists of the branches (OSS) and the generations (commercial
 * long-term support), the oldest first.
 */
export function chooseBranches({ generations, today, branches, ltsBranches }) {
  const listed = listGenerations(generations, today);
  const oss = listed.filter((g) => g.type === "OSS");
  const lts = listed.filter((g) => g.type === "COMMERCIAL");
  const problems = [];
  const chosen = {};
  for (const [name, kind, text, discovered, other, key] of [
    ["branches", "OSS", branches, oss, lts, "oss"],
    ["lts-branches", "COMMERCIAL", ltsBranches, lts, oss, "lts"],
  ]) {
    const entries = parseList(text);
    if (entries.length === 0 && (text ?? "").trim() === "") {
      chosen[key] = discovered.map((g) => g.branch);
      continue;
    }
    const checked = checkOverride({
      name,
      kind,
      entries,
      discovered,
      other,
    });
    problems.push(...checked.problems);
    chosen[key] = entries;
  }
  if (problems.length > 0) {
    throw new Error(
      `The branches to freeze are wrong:\n- ${problems.join("\n- ")}`,
    );
  }
  return chosen;
}

export async function run(
  { apiUrl = DEFAULT_API_URL, project, today, branches, ltsBranches },
  { fetch },
) {
  const generations = await readGenerations({ apiUrl, project }, { fetch });
  return chooseBranches({ generations, today, branches, ltsBranches });
}

export async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const result = await run(
    {
      apiUrl: core.getInput("api-url") || DEFAULT_API_URL,
      project: core.getInput("project", { required: true }),
      today,
      branches: core.getInput("branches"),
      ltsBranches: core.getInput("lts-branches"),
    },
    { fetch: globalThis.fetch },
  );
  core.setOutput("oss-branches", result.oss.join(","));
  core.setOutput("lts-branches", result.lts.join(","));
  core.info(`OSS branches to freeze: ${result.oss.join(", ") || "none"}`);
  core.info(
    `Long-term support branches to freeze: ${result.lts.join(", ") || "none"}`,
  );
}

if (isMain(import.meta.url)) {
  execute(main);
}
