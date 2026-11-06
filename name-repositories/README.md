# name-repositories

Names what follows from the repository that runs the workflow. The embargoed branches only exist in the commercial repository (`spring-security-commercial`). The project of the release train, and the OSS repository with the milestones and the issues of the releases (`spring-security`), are named after it: its name without `-commercial`. A hotfix is only released from the commercial repository, so its milestone and issues are in that one, and the release workflow does not use the OSS repository for them.

## What it does

- A repository without `-commercial` is its own project and OSS repository.
- The commercial repository is the project with `-commercial`, so a workflow that runs from the OSS repository finds the commercial one.
- It fails for something that is not `owner/name`.

## Inputs

| Input | Default | Description |
|---|---|---|
| `repository` | `GITHUB_REPOSITORY` | The repository, `owner/name`. The one that runs the workflow if it is not given. |

## Outputs

| Output | Description |
|---|---|
| `owner` | The owner of the repository. |
| `project` | The name of the repository without `-commercial`: the project id in the release train. |
| `oss-repository` | `owner/project`: the repository with the milestones and the issues. |
| `commercial-repository` | `owner/project-commercial`: the repository with the embargoed and release branches. The repository itself when it runs from the commercial one. |

## Secrets and permissions

None.

## Using it

```yaml
- id: repositories
  uses: spring-io/spring-security-actions/name-repositories@v1
- run: echo ${{ steps.repositories.outputs.oss-repository }}
```

## Running it locally

An ordinary Node program (Node 24). `npm ci` once in this directory, then run it with its inputs as `INPUT_<NAME>` variables, and the file of its outputs as `GITHUB_OUTPUT`:

```shell
cd name-repositories
npm ci
export GITHUB_OUTPUT=$(mktemp)
env 'INPUT_REPOSITORY=spring-projects/spring-security-commercial' node src/index.js
cat "$GITHUB_OUTPUT"
```

`npm test` runs its tests, with no network and no token.
