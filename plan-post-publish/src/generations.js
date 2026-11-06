const DEFAULT_API_URL = "https://api.spring.io";

/**
 * The generations of a project from the Spring projects API
 * (GET <api>/projects/<project>/generations, a HAL list in _embedded.generations, each
 * with name, ossSupportEndDate and commercialSupportEndDate as YYYY-MM-DD or null): what
 * `spring-versions` shows.
 */
export async function readGenerations({ apiUrl, project }, { fetch }) {
  const url = `${(apiUrl || DEFAULT_API_URL).replace(/\/$/, "")}/projects/${encodeURIComponent(project)}/generations`;
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
 * branch of an OSS generation is its name, except for the newest one, which is main.
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
