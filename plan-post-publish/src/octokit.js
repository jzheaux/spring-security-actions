import { Octokit } from "@octokit/rest";

const DEFAULT_API_URL = "https://api.github.com";

/**
 * An Octokit for a token (without one, the requests are unauthenticated). The API URL
 * is GITHUB_API_URL, the standard variable that GitHub Actions sets, so a local run or a
 * test can point an action to a fake server instead of GitHub.
 */
export function createOctokit({
  token,
  baseUrl,
  retries = 3,
  retryDelayMs = 2000,
} = {}) {
  const octokit = new Octokit({
    auth: token || undefined,
    baseUrl: baseUrl || process.env.GITHUB_API_URL || DEFAULT_API_URL,
    userAgent: "release-automation-actions",
  });
  // GitHub answers now and then with a 5xx (a 504 "We couldn't respond to your request
  // in time" was seen in a run). A request that only reads is tried again, a few times,
  // with a longer wait each time. One that writes is not: it may have been done.
  octokit.hook.wrap("request", async (request, options) => {
    const reads = ["GET", "HEAD"].includes(options.method);
    for (let attempt = 0; ; attempt++) {
      try {
        return await request(options);
      } catch (error) {
        if (!reads || !(error.status >= 500) || attempt >= retries) {
          throw error;
        }
        await new Promise((resolve) =>
          setTimeout(resolve, retryDelayMs * 2 ** attempt),
        );
      }
    }
  });
  return octokit;
}

/** The owner and the repo of "owner/repo". */
export function parseRepository(repository) {
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec((repository ?? "").trim());
  if (!match) {
    throw new Error(`"${repository}" is not a repository: expected owner/repo`);
  }
  return { owner: match[1], repo: match[2] };
}

/**
 * Awaits a request to GitHub, and describes a failure of it: what was being done, and
 * the status GitHub answered with, with a hint for the usual ones.
 */
export async function call(what, request) {
  try {
    return await request;
  } catch (error) {
    if (!error.status) {
      throw error;
    }
    const hints = {
      401: " (the token was refused)",
      403: " (the token is not allowed to do that: check its permissions)",
      404: " (the repository was not found, or the token cannot read it)",
      422: " (GitHub refused it: for example a label, a milestone or an issue type that is not valid for the repository)",
    };
    throw new Error(
      `${what} failed with ${error.status} ${error.message}${hints[error.status] ?? ""}`,
    );
  }
}
