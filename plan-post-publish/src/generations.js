const DEFAULT_API_URL = "https://api.spring.io";

/**
 * The generations of a project from the Spring projects API
 * (GET <api>/projects/<project>/generations, a HAL list in _embedded.generations, each
 * with name, initialReleaseDate, ossSupportEndDate and commercialSupportEndDate as YYYY-MM-DD or null): what
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

const initialReleaseOf = (name, date) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) {
    throw new Error(
      `The generation ${name} has no initialReleaseDate (YYYY-MM-DD) in the Spring projects API, which is the order of the generations`,
    );
  }
  return date;
};

/**
 * Oldest first: by the date of the initial release, and then by name. The names cannot be
 * compared by their numbers: Spring Session calls a generation 2021.2.x, which is older than
 * 3.4.x and 4.2.x. The end of the OSS support is no order either, as generations tie on it
 * (Spring Security's 5.8.x and 6.0.x).
 */
const byRelease = (a, b) =>
  a.initialRelease.localeCompare(b.initialRelease) ||
  a.generation.localeCompare(b.generation);

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
      initialReleaseDate: g.initialReleaseDate,
      ossSupportEnd: g.ossSupportEndDate ?? null,
      commercialSupportEnd: g.commercialSupportEndDate ?? null,
    }))
    .filter(
      (g) => g.commercialSupportEnd !== null && g.commercialSupportEnd >= today,
    )
    .map((g) => ({
      ...g,
      initialRelease: initialReleaseOf(g.generation, g.initialReleaseDate),
      type:
        g.ossSupportEnd !== null && g.ossSupportEnd >= today
          ? "OSS"
          : "COMMERCIAL",
    }))
    .sort(byRelease);
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
