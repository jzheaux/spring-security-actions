# ready-train

Runs the workflow `Release Train - Ready` (`release-train-ready.yml`) of the project on each release branch of a code freeze, and waits for every run. That workflow runs `ready` in the release train repository for the commit of the branch it runs on. A release that is ready is not changed any more, so the freeze marks it ready before it moves the branches on.

## What it does

- It reads the releases of the plan (`release/7.0.5`, `release/7.0.5.1`, `release/6.5.11`). One that the plan says is ready already (`alreadyReady`) is skipped, with the conclusion `already-ready` and no run. For the others it dispatches the workflow on each one, with the inputs `release-train` and `release-train-repository`.
- Dispatching a workflow does not say which run it made, so the run is the newest one of that workflow on that branch made since the dispatch. If it cannot be found, the link is the list of the runs on that branch, the run is not waited for, and the action fails.
- It waits for every run (up to 30 minutes each), and fails, naming each one, if any did not succeed.

## Inputs

| Input | Default | Description |
|---|---|---|
| `plan-file` | `code-freeze/plan.json` in `RUNNER_TEMP` | The plan. |
| `ready-file` | `code-freeze/ready.json` in `RUNNER_TEMP` | Where to write the runs. |
| `repository` | `GITHUB_REPOSITORY` | The commercial repository, which has the release branches and the workflow. |
| `release-train-repository` | `spring-io/release-train` | Given to the workflow. |
| `token` | required | A token that may run workflows of the repository. |
| `poll-interval` | `3` | Seconds between two looks at a run. |

## Outputs

`ready-file`: for each release, `branch`, `version`, `runUrl` and `conclusion` (`success`, `failure`, `not-found`...).

## Secrets and permissions

The token needs **Actions: Read and write** on the repository (a fine-grained token), or the scope `repo` (a classic one: no `workflow` scope is needed, that one is for changing workflow files). The workflow must be on the release branch.

## Trying it

`npm ci`, then `npm test`: the tests need no network.
