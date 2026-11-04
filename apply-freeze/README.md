# apply-freeze

Makes the merges and the version commits of a code freeze, in the clone, and pushes nothing. The order is the one that keeps the commercial code out of OSS.

## What it does

The branches of the OSS remote are worked on in `refs/freeze/oss/<branch>`, and the ones of the commercial remote in `refs/freeze/commercial/<branch>`: a branch of the clone, or a remote branch, is never changed, and an OSS branch is never the commercial branch of the same name (`main` is a branch of both). It works on a detached HEAD.

1. **OSS**, oldest first. The branch before it is merged **across**, and then the version commit.
2. **For each generation:** the frozen branch merges the frozen one before it across, and then the OSS branch **down**. The active branch merges the active one before it across, and then the frozen branch down. So the OSS branches are finished, from the OSS remote alone, before any commercial branch reads them.
3. **Long-term support**, oldest first: the one before it across, and then the version commit. They merge into each other only.
4. **The rotation.** Each frozen branch is fast forwarded to its active branch (`--ff-only`). That always works, because the last thing merged into active is the finished frozen branch. If it does not, the freeze fails.

**Across** (`merge(ours): 7.0.x into 7.1.x`): the version of the **target** stays. The merge is made with `--no-commit`, `gradle.properties` is restored to the target's, and then it is committed. Every other change comes with the merge, and a conflict in any other file fails the freeze (the merge is undone).

**Down** (`Merge branch '7.0.x' into 7.0.x`): the version of the **source** is taken, so the three branches of a generation share one version. The message has no embargoed branch in it, because a frozen branch becomes public.

**The version commit** is `Next Development Version (7.0.6-SNAPSHOT)`: it changes only the line `version=`, is signed off and is not signed with a key. A branch whose version does not change (`bump: false`) gets none, and is merged all the same. A branch that has the other in its history already is not merged.

## Inputs

| Input | Default | Description |
|---|---|---|
| `plan-file` | `code-freeze/plan.json` in `RUNNER_TEMP` | The plan, from `plan-freeze`. |
| `apply-file` | `code-freeze/apply.json` in `RUNNER_TEMP` | Where to write what was done. |
| `commercial-remote`, `oss-remote` | `origin`, `oss` | The remotes. |
| `path` | `.` | The clone. It needs a clean working tree and an identity (`git-identity`). |

## Outputs

`apply-file`: for each branch the ref, `before`, `after` and `changed`; the merges (`kind`, `message`, `outcome`); the version commits; the rotation; and `created`, the commits made in each repository. `push-freeze` checks them.

## Secrets and permissions

None, it only works in the clone.

## Trying it

`npm ci`, then `npm test`: it makes bare repositories in a temporary directory.
