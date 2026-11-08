# export-merges

Exports the branches that [`merge-tag`](../merge-tag/README.md) made, to look at in a dry run: a git repository with only those branches, which the workflow uploads as an artifact of the run next to the back-up of the branches that are deleted. A dry run merges in a clone of the runner and pushes nothing, so without this the merges are gone when the run ends.

## What it does

- It makes a new repository in `directory` (it must not exist, or be empty) and fetches the branches of the merges from the work refs of the clone: the merged ones and the ones that already had the tag. Each is named as it is in its repository (`7.1.x`, `embargoed/active/main`), and the history of each is in it, so the commit before a merge is too.
- The directory has a `README.md` with a table of the branches (repository, commit, and the commit before the merge, or `up to date`), the ref that stands in for the tag in a dry run before the tag exists, and the commands to look at a merge (`git log --graph --oneline`, `git diff`). The summary of the step has the same table.
- **It is for looking only.** It has no remote and no command that pushes. The branches of a dry run before the tag exists have commits of the commercial repository, which must never go to OSS.
- No token: it reads the clone on the disk of the runner. Only whoever can read the commercial repository can download the artifact, as with the back-up.
- A branch name in the merges of two repositories fails, as the export has one branch of each name.

## Inputs

| Input | Required | What it is |
|---|---|---|
| `plan-file` | no | The plan of `plan-post-publish`, for the names of the repositories. `post-publish/plan.json` in `RUNNER_TEMP` by default. |
| `merge-file` | no | What `merge-tag` did. `post-publish/merge.json` in `RUNNER_TEMP` by default. |
| `name` | no | The name of the export: its directory, and the artifact. `merged-branches-<tag>` by default. |
| `directory` | no | Where to make it. The default is `name` in `RUNNER_TEMP`. |
| `dry-run` | no | `true` if the run is a dry run, which the summary and the README say. |
| `path` | no | The clone that `merge-tag` worked in. `.` by default. |

## Outputs

`directory`, `name` and `count` (how many branches were exported: with 0 there is nothing to upload).

## Using it

```yaml
- id: export
  uses: spring-io/spring-security-actions/export-merges@v1
  with:
    dry-run: true
- uses: actions/upload-artifact@v7
  with:
    name: ${{ steps.export.outputs.name }}
    path: ${{ steps.export.outputs.directory }}
    include-hidden-files: true
```

## Trying it

`npm ci`, then `npm test`: the tests make a clone with the work refs of a merge by hand, and need no network.
