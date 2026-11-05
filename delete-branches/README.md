# delete-branches

Deletes branches of a repository, all at once or none, with `git push --atomic --delete`, which GitHub applies as one transaction. The GitHub API deletes one branch per call, so it cannot do that.

## What it does

- It reads the branches of the repository first. If one of the branches **does not exist**, or is the **default branch**, it deletes nothing and fails.
- It fails, and deletes nothing, if GitHub refuses the push for one of them (a branch protection or a ruleset).
- It works in an empty temporary repository, so it needs no checkout. The token is the credentials of the requests (an `http.extraheader` given through the environment, so it is in no command line), and is masked in the logs.
- The summary of the step has a table of the branches and what happened to each: `deleted`, `not deleted`, `not found` or `default branch`.

## Inputs

| Input | Required | What it is |
|---|---|---|
| `repository` | yes | `owner/repo`. |
| `branches` | yes | The branches, one per line, without `refs/heads/`. A name that is not valid, or that is there twice, is an error. |
| `token` | yes | A token that can push to the repository: `contents: write`. |

## Outputs

`deleted`: the branches that were deleted, one per line. It is not set if the action fails.

## Using it

```yaml
- uses: spring-io/spring-security-actions/delete-branches@v1
  with:
    repository: spring-projects/spring-security-commercial
    branches: |
      release/7.0.1
      embargoed/7.0.1-INTERNAL-SNAPSHOT
    token: ${{ secrets.RELEASE_AUTOMATION_TOKEN }}
```

## Running it locally

`npm ci` once in this directory, then run it with its inputs as `INPUT_<NAME>` variables. It deletes branches for real:

```shell
cd delete-branches
npm ci
env INPUT_REPOSITORY=owner/repo INPUT_BRANCHES=try/branch INPUT_TOKEN="$(gh auth token)" node src/index.js
```

`npm test` runs its tests, against repositories in a temporary directory: no network and no token.
