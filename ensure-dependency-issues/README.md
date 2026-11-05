# ensure-dependency-issues

Makes sure that every dependency update has an issue in a milestone, and creates the ones that are missing, **without a body**. The commit of an update closes its issue (`update-versions` writes `Closes gh-123`), so the issue must exist before the commit. With `close` (the default), a new issue is **closed at once**, for the issues of a hotfix, whose commits are made already. Without it, the issue is left open, for its commit to close it when that is merged (an OSS release). An issue of an update that is not in the release train any more is taken out of the milestone. It knows nothing about the release train.

## How it decides

The title of the issue of an update is fixed: `Update spring-framework to 7.0.10`. For every update:

- An issue **of the milestone** that has **exactly that title** is the issue of the update, **open or closed**. It is not created again, and its state is not changed, so a run that is done again does not make a second issue.
- Otherwise the issue is created, in the milestone, with the labels and the issue type that were given, with no body, and, if `close` is not `false`, is closed (as completed).
- A pull request is an issue to GitHub, and is not taken for the issue of an update.
- The version is part of the title, so another version of the same dependency in the same milestone is another issue (`Update spring-framework to 7.0.11`).

If there is more than one issue with the title, which is not meant to be, an open one is taken, and else the first.

**An update that is not in the train any more.** An issue of the milestone that has the title of an update (`Update <name> to <version>`) and every label that was given, and whose title is not one of the updates of this run, gets a comment, and is taken out of the milestone:

> Removed from the milestone 7.0.1 because `spring-framework 7.0.10` was not found in the release train on the latest run.

That is a dependency that left the train, and also the old version of one that has a new one. An issue that is out of the milestone is not looked at again, so a run that is done again comments once. An issue that is not titled like an update, or lacks a label, is not touched. Each is said in a notice, **Removed from the milestone**.

## Inputs

| Input | Required | Description |
|---|---|---|
| `versions` | yes | The updates, as a JSON object from the name of a dependency to its new version: `{"spring-framework":"7.0.10"}`. The output `versions` of `map-train-versions`. |
| `repository` | yes | The repository (`owner/repo`) that has the issues. |
| `milestone` | yes | The title of the milestone that the issues are in. It must exist. |
| `labels` | no | The labels of the issues that are created, and that an issue needs to be taken out of the milestone, separated by commas or lines: `type: dependency-upgrade`. GitHub creates a label that does not exist. |
| `close` | no | `true` (the default) closes an issue that is created, as completed. `false` leaves it open. |
| `type` | no | The issue type of the issues that are created. Only a repository of an organization that has issue types takes it. |
| `token` | yes | A token that can read, create, close and edit issues in the repository, see below. |

## Outputs

| Output | Description |
|---|---|
| `issues` | A JSON object from the name of a dependency to `{ version, issue, existed }`: `{"spring-framework":{"version":"7.0.10","issue":123,"existed":false}}`. |
| `updates` | The updates to make, as `update-versions` takes them, with the version and the issue only: `{"spring-framework":{"version":"7.0.10","issue":123}}`. |
| `removed` | The issues that were taken out of the milestone, as a JSON list of `{ issue, title }`. |
| `count` | How many. |

## Two things about GitHub that were measured

**A new issue is listed a few seconds after it is created.** On GitHub, 2 to 5 seconds. A run that comes right after another one (a push that cancels the run of the one before it) would not find the issues that the other created, and make them again. So after it has created issues, the action waits until the list has all of them (up to 30 seconds), and warns if it has not. A run that creates nothing does not wait.

**GitHub is retiring the version `2022-11-28` of its API.** It is the version that Octokit uses, and GitHub answers a request that creates an issue with a `Deprecation` header, which Octokit prints as `"POST .../issues" is deprecated. It is scheduled to be removed on Fri, 10 Mar 2028`. It is a warning, and it is not about this action: the version is set to be removed on 2028-03-10. The newer version `2026-03-10` is accepted already. The actions have not been moved to it, because it has not been tested for every request that they make. Do that before March 2028.

## Fails when

- the milestone does not exist
- an update has no version, or the versions are not JSON
- GitHub refuses to read or to create an issue. The message says what was being done, and how GitHub answered: `403` means that the token is not allowed to create issues, and `422` that a label or an issue type is not valid.

## Secrets and permissions

The action writes issues, so it needs a token that can write them. The release workflow gives the repository of the issues: the **OSS repository** for a release, which is another repository than the one that runs the release workflow (its issues are left open, `close: false`), and the repository that runs it (the commercial one) for a hotfix and an LTS version, with the milestone of the hotfix (its issues are closed). The `GITHUB_TOKEN` of the release workflow cannot write the issues of either (its permission is `contents: read`). A token that is stored as a secret is needed, with write access to the **issues** of the repository, and nothing else:

- a fine-grained personal access token, with that repository as its only repository, and **Issues: Read and write**
- a classic personal access token with the `repo` scope (`public_repo` is enough for a public repository). It is broader.

Create it at https://github.com/settings/personal-access-tokens (fine-grained) or https://github.com/settings/tokens (classic), and store it as a secret of the repository that runs the workflow. The release workflow uses the secret `RELEASE_AUTOMATION_TOKEN`, see `.github/RELEASE_AUTOMATION.adoc`.

A workflow that runs in the repository that has the issues can use its own `GITHUB_TOKEN`, with the permission `issues: write`.

## Using it

```yaml
- id: issues
  uses: spring-io/spring-security-actions/ensure-dependency-issues@v1
  with:
    versions: ${{ steps.map.outputs.versions }}
    repository: your-github-user/spring-merge
    milestone: ${{ steps.release.outputs.release-version }}
    labels: "type: dependency-upgrade"
    token: ${{ secrets.RELEASE_AUTOMATION_TOKEN }}
```

## Running it locally

It is an ordinary Node program (Node 24). `npm ci` once in this directory. Against the fake GitHub of the tests, which has the milestones of the tutorial and creates the issues in memory:

```shell
cd ensure-dependency-issues
npm ci
node test/support/fake-github.js 8123 &
export GITHUB_API_URL=http://127.0.0.1:8123 GITHUB_OUTPUT=$(mktemp)
env 'INPUT_VERSIONS={"spring-framework":"7.0.10","micrometer":"1.16.8"}' \
    'INPUT_REPOSITORY=tutorial/spring-merge' 'INPUT_MILESTONE=7.0.1' \
    'INPUT_LABELS=type: dependency-upgrade' \
    node src/index.js
cat "$GITHUB_OUTPUT"
kill %1
```

Or against your practice repository, which makes real issues: it needs a token that can create them (`INPUT_TOKEN=$(gh auth token)`), and the milestone `7.0.1` that `./setup.sh` created. Run it twice, and see that the second run creates nothing. `npm test` runs its tests, which need no network and no token.
