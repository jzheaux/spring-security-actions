# backup-branches

Backs up branches that are going to be deleted: a git repository with only those branches, which the workflow uploads as an artifact of the run, and the commands that put the branches back. Once the branches are deleted the commits are gone from the remote, so the shas alone do not bring them back.

## What it does

- It makes a new repository in `directory` (it must not exist, or be empty) and fetches **only** the branches that were asked for, with their history. A branch that does not exist is skipped.
- The token is the credentials of the requests only (an `http.extraheader` given through the environment): it is in no file of the backup, and is masked in the logs. The workflow must check out with `persist-credentials: false` too, if it uploads the checkout.
- The directory has a `RESTORE.md` with the commands, and the summary of the step has them with the commits:

```
git push git@github.com:spring-projects/spring-security-commercial.git fc6c49669dfe4c8aa137d56855f01d9f1d1b3375:refs/heads/release/7.1.3
```

Run from inside the unzipped artifact, each command pushes a branch back at the commit it had.

## Inputs

| Input | Required | What it is |
|---|---|---|
| `repository` | yes | `owner/repo` that has the branches. |
| `branches` | yes | The branches, one per line, without `refs/heads/`. |
| `name` | yes | The name of the backup: its directory, and the artifact, for example `restore-deleted-branches-7.1.3`. |
| `directory` | no | Where to make the clone. The default is `name` in `RUNNER_TEMP`. |
| `token` | yes | A token that can read the repository (`contents: read`). |

## Outputs

`directory`, `name`, `count` (how many branches were backed up: with 0 there is nothing to upload), `branches` (`branch=commit`, one per line) and `missing` (the ones that do not exist).

## Using it

```yaml
- id: backup
  uses: spring-io/spring-security-actions/backup-branches@v1
  with:
    repository: spring-projects/spring-security-commercial
    branches: |
      release/7.1.3
      embargoed/7.1.3-INTERNAL-SNAPSHOT
    name: restore-deleted-branches-7.1.3
    token: ${{ secrets.RELEASE_AUTOMATION_TOKEN }}
- if: steps.backup.outputs.count != '0'
  uses: actions/upload-artifact@<commit>
  with:
    name: ${{ steps.backup.outputs.name }}
    path: ${{ steps.backup.outputs.directory }}
    include-hidden-files: true
    overwrite: true
```

The artifact is attached to the run, and not to the repository. `include-hidden-files` is needed, as the backup is a `.git` directory.

## Running it locally

```shell
cd backup-branches
npm ci
env INPUT_REPOSITORY=owner/repo INPUT_BRANCHES=release/1.0 INPUT_NAME=restore-deleted-branches-1.0 INPUT_DIRECTORY=/tmp/backup INPUT_TOKEN="$(gh auth token)" node src/index.js
```

`npm test` runs its tests, against repositories in a temporary directory: no network and no token.
