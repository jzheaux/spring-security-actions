# merge-tag

Merges the tag of a release that was made public into its branch, and then forward through the newer branches, in the clone, and pushes nothing (`push-merges` does). The tag has the fixes for the vulnerabilities that were embargoed until the release, so they have to reach every newer branch. The versions of the branches are not the ones of the tag, so they are kept.

## What it does

The branches of the OSS repository are worked on in `refs/post-publish/oss/<branch>`, and the ones of the commercial repository in `refs/post-publish/commercial/<branch>`: a branch of the clone, or a remote branch, is never changed, and an OSS branch is never the commercial branch of the same name (`main` is a branch of both). It works on a detached HEAD. It needs the plan of `plan-post-publish`: a hotfix has none, and nothing is done.

**An OSS release** (the tag is in the OSS repository, which is fetched with the branches of the chain):

1. **OSS**, oldest first: the tag into the first branch (`Merge tag '7.0.9' into 7.0.x`), and then each branch into the next (`Merge branch '7.0.x' into 7.1.x`). This is done from the OSS repository alone, before any commercial branch reads it.
2. **For each generation of the chain:** the frozen branch merges the frozen one before it across, and then the OSS branch **down** (`Merge branch '7.0.x' into 7.0.x`). The active branch merges the active one before it across, and then the frozen branch down.

**A long-term support release** (the tag is in the commercial repository): the tag into its `embargoed/lts/<generation>` branch, and then each branch into the next (`Merge branch '6.4.x' into 6.5.x`). The OSS repository is **never** added or read.

A merge is a real merge: everything that the source has comes, which is how the fixes arrive. Two files are settled, whether they conflict or not:

| Merge | `gradle.properties` | `gradle/libs.versions.toml`, where both sides changed the same lines |
|---|---|---|
| the tag into the first branch | the branch's | the tag's |
| across | the target's | the target's |
| down | the source's | the source's |

A line of the catalog that only the source changed comes with the merge, and the summary lists what each merge changed in the `[versions]`. Two changes on lines that touch each other are one conflict for git, and one side wins both. Any other conflict fails the run with **Merge conflict**, names the files, and leaves nothing pushed: merge it by hand and run it again. A branch that already has the source in its history is not merged (`up-to-date`), so a run can be repeated after the branches were pushed.

No message names an embargoed branch, as a frozen branch becomes public.

## Inputs

| Input | Default | Description |
|---|---|---|
| `plan-file` | `post-publish/plan.json` in `RUNNER_TEMP` | The plan, from `plan-post-publish`. |
| `merge-file` | `post-publish/merge.json` in `RUNNER_TEMP` | Where to write what was done. |
| `commercial-remote` | `origin` | The remote of the commercial repository. |
| `oss-remote` | `oss` | The name of the remote added for the OSS repository. |
| `oss-url` | the repository of the plan | The URL of the OSS repository. |
| `dry-run` | `false` | `true` says so in the summary. The merges are made in the clone either way. |
| `path` | `.` | The clone. It needs a clean working tree, an identity (`git-identity`), and all the branches (`fetch-depth: 0`). |
| `token` | | A token that can read the OSS repository. |

## Outputs

`merge-file`: for each branch the ref, `before`, `after` and `changed`; the merges (`kind`, `repository`, `source`, `into`, `message`, `outcome`, `commit`, and the `catalog` changes); and `created`, the commits made in each repository, which `push-merges` checks.

## Secrets and permissions

None of its own. The token only reads the OSS repository, which is public. Nothing is pushed.

## Trying it

`npm ci`, then `npm test`: the tests make bare repositories in a temporary directory, with a tag that has a fix, and check the fix, the versions and the catalog of every branch, a second run, and a conflict.
