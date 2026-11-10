import { git, gitTry } from "./git.js";

const FIELD = "\x1f";
const RECORD = "\x1e";
const FORMAT = `%H${FIELD}%P${FIELD}%s${FIELD}%b${RECORD}`;

/** The commits that git log printed in the format above, as { sha, parents, subject, body }. */
function parse(text) {
  return text
    .split(RECORD)
    .map((record) => record.replace(/^\n+/, ""))
    .filter((record) => record.trim() !== "")
    .map((record) => {
      const [sha, parents, subject, body] = record.split(FIELD);
      return {
        sha,
        parents: parents ? parents.split(" ") : [],
        subject,
        body: (body ?? "").trim(),
      };
    });
}

/**
 * The commits of `to` that `from` does not have (git log from..to), the oldest first, without
 * the merge commits: the ones that are shown, and that the commands of the summary list.
 */
export function commitsNotIn(directory, from, to) {
  return parse(
    git(
      directory,
      "log",
      "--no-merges",
      "--reverse",
      `--format=${FORMAT}`,
      `${from}..${to}`,
    ),
  );
}

/**
 * The commits that were made on a branch after a commit, in the order that they were made,
 * merge commits too: the first parent of each is the one before it, which is how a branch
 * that was started at the pushed commit, and merged into, is read.
 */
export function commitsMadeAfter(directory, from, to) {
  return parse(
    git(
      directory,
      "log",
      "--first-parent",
      "--reverse",
      `--format=${FORMAT}`,
      `${from}..${to}`,
    ),
  );
}

/** How many commits `to` has that `from` does not, with or without the merge commits. */
export function countCommits(directory, from, to, { merges }) {
  return Number(
    git(
      directory,
      "rev-list",
      "--count",
      ...(merges ? [] : ["--no-merges"]),
      `${from}..${to}`,
    ),
  );
}

/** The commit that a ref points to, or undefined if there is no such ref. */
export function resolve(directory, ref) {
  const result = gitTry(
    directory,
    "rev-parse",
    "--verify",
    "--quiet",
    `${ref}^{commit}`,
  );
  return result.code === 0 ? result.stdout : undefined;
}
