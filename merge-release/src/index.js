import * as core from "@actions/core";
import { git, gitTry, requireIdentity } from "./git.js";
import { execute, isMain } from "./run.js";

const lines = (text) => (text ? text.split("\n") : []);

/**
 * Merges the branch that a hotfix is based on into the branch that is checked out, so that
 * the hotfix is based on it: the release (release/7.0.1) for the hotfix release, and the
 * snapshot (embargoed/7.0.1-INTERNAL-SNAPSHOT) for the hotfix snapshot, plus the fixes of the
 * active embargoed branch.
 *
 * The merge is a merge commit (Merge release/7.0.1 into release/7.0.1.1), signed off with the
 * identity that git is set up with, even if the branch could be fast forwarded to. It is made
 * from the branch of the remote (origin/release/7.0.1), as it was when the repository was
 * checked out.
 *
 * - If the branch does not exist (the frozen embargoed branch has not been pushed yet, or the
 *   snapshot was thrown away), it is a warning and nothing is merged: the hotfix is built from
 *   the active embargoed branch alone.
 * - If the branch is in the checked out one already, there is nothing to merge.
 * - If both sides changed the same lines, the side of the branch that is checked out wins
 *   (-X ours): the active embargoed branch is the one that has the fixes. The files that both
 *   sides changed are said in a notice, so that is not silent. A conflict that cannot be
 *   resolved that way (a file that one side deleted and the other changed, a binary file)
 *   fails, and the merge is undone.
 *
 * It returns merged: "true", "false" (there is no such release) or "up-to-date".
 */
export function mergeRelease({ directory, release }) {
  if (!release) {
    throw new Error("The input release is required, for example release/7.0.1");
  }
  requireIdentity(directory);
  const ref = `refs/remotes/origin/${release}`;
  const current = git(directory, "rev-parse", "--abbrev-ref", "HEAD");

  if (
    gitTry(directory, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`)
      .code !== 0
  ) {
    // The branch of a release is release/<version>: any other is a snapshot (embargoed/<version>-INTERNAL-SNAPSHOT)
    const snapshot = !release.startsWith("release/");
    const hotfix = snapshot ? "hotfix snapshot" : "hotfix";
    core.warning(
      `${release} does not exist, so the ${hotfix} is built from the active embargoed branch alone. Push the frozen embargoed branch to build the ${snapshot ? "snapshot" : "release"}, and the ${hotfix} is built on it the next time that the active embargoed branch is pushed.`,
      {
        title: snapshot
          ? "No snapshot to build the hotfix snapshot on"
          : "No release to build the hotfix on",
      },
    );
    return "false";
  }

  if (
    gitTry(directory, "merge-base", "--is-ancestor", ref, "HEAD").code === 0
  ) {
    core.info(`${release} is in ${current} already: there is nothing to merge`);
    return "up-to-date";
  }

  const base = gitTry(directory, "merge-base", "HEAD", ref);
  if (base.code !== 0) {
    throw new Error(
      `${release} and ${current} have no history in common, so ${release} cannot be merged`,
    );
  }
  const changed = (to) =>
    new Set(
      lines(
        git(
          directory,
          "-c",
          "core.quotepath=false",
          "diff",
          "--name-only",
          base.stdout,
          to,
        ),
      ),
    );
  const theirs = changed(ref);
  const both = [...changed("HEAD")].filter((file) => theirs.has(file)).sort();
  if (both.length > 0) {
    core.notice(
      `The active embargoed branch and ${release} both changed: ${both.join(" ")}. Where they changed the same lines, the active embargoed branch is kept.`,
      { title: "Changed on both sides" },
    );
  }

  const merge = gitTry(
    directory,
    "-c",
    "commit.gpgsign=false",
    "merge",
    "--no-ff",
    "--no-edit",
    "--signoff",
    "-X",
    "ours",
    "-m",
    `Merge ${release} into ${current}`,
    ref,
  );
  if (merge.code !== 0) {
    const conflicts = gitTry(
      directory,
      "diff",
      "--name-only",
      "--diff-filter=U",
    )
      .stdout.split("\n")
      .filter(Boolean)
      .join(" ");
    gitTry(directory, "merge", "--abort");
    throw new Error(
      `${release} could not be merged into ${current}: ${conflicts} cannot be merged by taking the side of the active embargoed branch. Merge ${release} into the active embargoed branch by hand (the merge forward), push it, and the hotfix is built again.`,
    );
  }
  core.info(
    `Merged ${release} into ${current}: ${git(directory, "rev-parse", "--short", "HEAD")}`,
  );
  return "true";
}

export async function main() {
  const merged = mergeRelease({
    directory: core.getInput("path") || ".",
    release: core.getInput("release"),
  });
  core.setOutput("merged", merged);
}

if (isMain(import.meta.url)) {
  execute(main);
}
