# plan-freeze

Plans a code freeze and says what is to be done, or everything that stops it. It changes no branch: it only adds the OSS repository as the remote `oss` of the clone of the commercial repository, and fetches it.

## What it looks at

For every OSS branch (`7.0.x`, `main`) it reads `gradle.properties` of the OSS branch and of `embargoed/frozen/<branch>` and `embargoed/active/<branch>` of the commercial repository: the three must have **one version**. A long-term support generation (`6.5.x`) has one branch, `embargoed/lts/6.5.x`.

**The next version.** The last segment plus one (`7.0.5-SNAPSHOT` gives `7.0.6-SNAPSHOT`). A `.0` version is the exception: it stays while the milestone `x.y.0` (the GA, open or closed) does not exist, and is `x.y.1-SNAPSHOT` once it does. Hotfix milestones (`7.2.0.1`) and milestones and release candidates (`7.2.0-RC1`) do not count. A version that stays gets no commit. The milestones are read from the OSS repository and from the commercial one.

**The releases to mark ready.** The release of a branch is worked out as `compute-release-version` does (`7.0.5`, or for a `.0` version the open milestone with the earliest due date: `7.2.0-M2`). `release/7.0.5` is built from the frozen branch, and is the release of the OSS branch too. The active branch has the hotfix `release/7.0.5.1` if it has changes that the frozen one lacks (and a `.0` only for its GA). Each release branch is listed once, with its milestone (`repository`, `number`, `url`, `state` and the `open` and `closed` issues), which `close-milestones` closes after the freeze: the OSS repository has the milestone of the releases of the OSS and frozen branches, and the commercial one has those of a hotfix and of long-term support. A release has `hotfix: true` for the hotfix.

## What stops it

All of these are listed together, and the plan is written all the same, for the summary:

- the repository that runs the freeze is not a commercial one (its name does not end with `-commercial`), or is the OSS repository,
- a branch does not exist, or has no `version=`, or the three branches of a generation have different versions,
- a `.0` version has no open milestone,
- the milestone of a hotfix does not exist in the commercial repository (the release workflow creates it),
- a `release/<version>` does not exist or has not joined the release train, or the train has not been created.

A release that is **ready already** in the train is not a problem: its entry in `releases` has `alreadyReady: true`, it is not marked ready again, and its branches are bumped all the same.

## Inputs

| Input | Default | Description |
|---|---|---|
| `project` | required | The project id in the release train. |
| `oss-repository` | required | The OSS repository, `owner/repo`. |
| `oss-branches` | required | The branches to freeze, oldest first (the output of `list-branches`). |
| `lts-branches` | | The long-term support generations to freeze. |
| `train` | required | The release train, `2026.11.19`. |
| `train-found`, `train-file` | `true` | Whether the train exists, and the file with `train.yml` as JSON (the outputs of `load-train`). |
| `token` | | A token that reads the milestones of both repositories. |
| `host-repository` | `GITHUB_REPOSITORY` | The commercial repository that runs the freeze. |
| `oss-url` | the server and `oss-repository` | Where to fetch the OSS repository from. The credentials are the ones that the checkout stored. |
| `path` | `.` | The clone of the commercial repository, with all its branches. |
| `plan-file` | `code-freeze/plan.json` in `RUNNER_TEMP` | Where to write the plan. |

## Outputs

`plan-file`. The plan has `oss` and `lts` (each branch with `current`, `next` and `bump`), `releases` (`version`, `branch`, `builtFrom`, `of`, `hotfix`, `milestone`) and `problems`.

## Secrets and permissions

The token reads milestones: **Issues: Read-only** on both repositories (fine-grained), or `repo` (classic).

## Trying it

`npm ci`, then `npm test`: it makes the two repositories as bare repositories in a temporary directory, and needs no network and no token.
