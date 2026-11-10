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
 * The merge commits of `from..to` that were made with `-s ours`: their tree is the one of their
 * first parent, so nothing of what they merged is in the branch. git diff --quiet says so
 * with the exit code 0.
 */
export function oursMerges(directory, from, to) {
  return git(directory, "rev-list", "--merges", `${from}..${to}`)
    .split("\n")
    .filter(Boolean)
    .filter(
      (merge) =>
        gitTry(directory, "diff", "--quiet", `${merge}^1`, merge).code === 0,
    );
}

/** What git is given to leave out what an `-s ours` merge merged in: its second parent. */
const withoutMerged = (ours) => ours.map((merge) => `^${merge}^2`);

/**
 * The commits of `to` that `from` does not have (git log from..to), the oldest first: the
 * ones that are shown, and that the commands of the summary list. Merge commits are in, except
 * the ones made with `-s ours` (`ours`, see oursMerges) and the commits that they merged in.
 */
export function commitsNotIn(directory, from, to, ours = []) {
  return parse(
    git(
      directory,
      "log",
      "--reverse",
      `--format=${FORMAT}`,
      ...withoutMerged(ours),
      `${from}..${to}`,
    ),
  ).filter(({ sha }) => !ours.includes(sha));
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

/**
 * How many commits `to` has that `from` does not, with or without the merge commits, leaving
 * out the `-s ours` merges (`ours`) and the commits that they merged in.
 */
export function countCommits(directory, from, to, { merges, ours = [] }) {
  const count = Number(
    git(
      directory,
      "rev-list",
      "--count",
      ...(merges ? [] : ["--no-merges"]),
      ...withoutMerged(ours),
      `${from}..${to}`,
    ),
  );
  return merges ? count - ours.length : count;
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
