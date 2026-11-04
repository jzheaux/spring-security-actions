import { gitTry } from "./git.js";
import { resolve } from "./commits.js";

/**
 * Reads what the summary compares the branches with from the OSS repository, which is public:
 * its tags, and, for a frozen or a long-term support branch, the branch of the generation.
 * They are fetched into refs of their own (refs/oss-tags/*, refs/remotes/oss/<branch>), so a
 * tag of the repository that is checked out is never replaced.
 *
 * It never throws: the summary is not worth a failed release. If OSS cannot be read, `error`
 * says why, and the summary compares the branches with something else and says so.
 *
 * It returns { url, branchRef, tagRef, error }: the refs are the ones that exist. A branch or a
 * tag that OSS does not have is not an error: it is no ref.
 */
export function fetchOss({ directory, url, branch, tag }) {
  if (!url) {
    return {};
  }
  const said = (result) =>
    result.stderr.split("\n").filter(Boolean).at(-1) || "git fetch failed";
  // the tags first, apart from the branch: a generation that OSS has no branch for yet must
  // not cost the tags
  const tags = gitTry(
    directory,
    "fetch",
    "--quiet",
    "--no-tags",
    url,
    "+refs/tags/*:refs/oss-tags/*",
  );
  if (tags.code !== 0) {
    return { url, error: said(tags) };
  }
  let branchRef;
  if (branch) {
    const fetched = gitTry(
      directory,
      "fetch",
      "--quiet",
      "--no-tags",
      url,
      `+refs/heads/${branch}:refs/remotes/oss/${branch}`,
    );
    if (fetched.code === 0) {
      branchRef = resolve(directory, `refs/remotes/oss/${branch}`)
        ? `refs/remotes/oss/${branch}`
        : undefined;
    } else if (!/couldn't find remote ref/.test(fetched.stderr)) {
      return { url, error: said(fetched) };
    }
  }
  return {
    url,
    branchRef,
    tagRef:
      tag && resolve(directory, `refs/oss-tags/${tag}`)
        ? `refs/oss-tags/${tag}`
        : undefined,
  };
}
