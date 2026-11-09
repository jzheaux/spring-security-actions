# The release automation

A push to an embargoed branch of the commercial repository builds the branches of its release, with no one doing it by hand. This is the guide to it: what it builds, what it needs, how to give it the secrets that it needs, and what to do when it fails.

## Setup checklist

What a project needs before a push builds anything. Each point has its section below.

1. **The caller workflow** in the commercial repository, `.github/workflows/release-branches.yml`, on every embargoed branch (it comes with the merges forward): it runs for a push to `embargoed/frozen/**`, `embargoed/active/**` and `embargoed/lts/**`, and by hand (`workflow_dispatch`), and calls the reusable workflow at a commit of a tag. See [Calling it](#calling-it).
2. **The secret** `RELEASE_AUTOMATION_TOKEN` in the commercial repository, and the variables `UBUNTU_RUNS_ON` (the runners of the organization) and, if it is not `spring-io/release-train`, `RELEASE_TRAIN_REPOSITORY`. See [the tokens](#the-secret-the-variable-and-the-tokens).
3. **The version** of `gradle.properties` of an embargoed branch is `<major>.<minor>.<patch>-SNAPSHOT` (`7.0.9-SNAPSHOT`), also on an active one: its hotfix, `7.0.9.1`, is worked out from it.
4. **The milestone of the release**, with a due date. A release or an LTS version (`7.0.9`, `5.8.30`): in the OSS repository, and in the commercial repository for an LTS version. A hotfix (`7.0.9.1`): in the commercial repository, and the milestone of the version that it fixes (`7.0.9`) in the OSS repository, which decides its release train with its due date. The description of the milestone of an LTS version, which is commercial, names its release train: `Release Train: 2026.10.22`. Only a commercial version names its train. If a milestone is missing, the workflow creates it, with a title and nothing else (no due date, no release train). For a frozen or an LTS version there is nothing to build until it is in a train, so the run ends with the notice **Milestone created**, and the summary says what to set. A hotfix milestone is created whatever the OSS milestone has, and the run goes on if the OSS milestone has a due date. Every OSS version (frozen) is also a milestone of the commercial repository, due when the OSS milestone is (and following it if that changes), so that the issues of a fix that only customers get, such as a CVE, have one: it is made once the OSS milestone has a due date. If a milestone exists but is not in a train, the run fails, and its summary says what to change.
5. **The release train** branch in the release train repository: the due date of the milestone of a release, the due date of the OSS milestone of a hotfix (or the train that the description of its milestone names), the train that the description of the milestone of an LTS version names (it may not exist yet: then the branches are built without the dependency updates, and nothing joins). See [the release train](#the-release-train).
6. **The version catalog**, `gradle/libs.versions.toml`, has a `[versions]` entry named after each project of the train, one per line: `spring-framework = "7.0.9"`.
7. **The workflow `release-train-join.yml`** ("Release Train - Join") on the release branches (it is on the embargoed branches, so the release branches have it), which joins the train. See [what a run does](#what-a-run-does-in-order).
8. **A `build.gradle` or `build.gradle.kts` in the root**, for the commercial license of a hotfix (the Broadcom license of the POM is applied from there).

## What a push builds

The reusable workflow [`release-branches.yml`](../.github/workflows/release-branches.yml) of this repository, and the actions that it uses (each is a directory of this repository, with a README). The project calls it for a push to `embargoed/frozen/**`, `embargoed/active/**` or `embargoed/lts/**`. It builds the branches of the release again from the pushed commit, every time, and pushes them once, both or none, forced. Nobody commits to them.

A push to a snapshot branch that it built (`embargoed/*-SNAPSHOT`) is for the project to publish: the pushes are made with `RELEASE_AUTOMATION_TOKEN`, so they run the workflows of the project.

|  | A frozen embargoed branch, `embargoed/frozen/7.0.x` (`7.0.1-SNAPSHOT`) | An active embargoed branch, `embargoed/active/7.0.x` (`7.0.1-SNAPSHOT`) |
|---|---|---|
| The release | `release/7.0.1`, from the pushed commit. For a `.0` version (`7.1.0-SNAPSHOT`) the release is the next milestone: `release/7.1.0-RC1` | `release/7.0.1.1`, from the pushed commit with **`release/7.0.1` merged in**: it is the hotfix of `7.0.1` |
| The commits of the release | one for each dependency that the release train asks for, with its issue (`Closes gh-123`), and then `Release 7.0.1` | the merge of `release/7.0.1`, the commercial license, one for each dependency that has a hotfix version in the train, with its issue in the commercial repository (the others keep the version that the release has), and then `Release 7.0.1.1` |
| The snapshot branch | `embargoed/7.0.1-INTERNAL-SNAPSHOT`: its version, and an internal snapshot of every dependency that has joined the train (no issues). Thrown away when the release is done | `embargoed/7.0.1.1-SNAPSHOT`: **`embargoed/7.0.1-INTERNAL-SNAPSHOT` merged in** first, then the commercial license and the Broadcom headers, its version, and a snapshot of every dependency that has a hotfix version in the train (no issues) |
| Not built | a hotfix (a frozen embargoed branch has none) | nothing at all for a version that ends with `.0` while its next release is a milestone or a release candidate (`7.2.0-M1`, `7.2.0-RC1`): they have no hotfix, and the hotfix `7.2.0.1` is built once the next release is the GA `7.2.0` (the notice **No release** says so), and nothing at all for an active embargoed branch that has no changes that the frozen one of its generation lacks (a notice says so) |

### OSS support must last until the release is public

A frozen or active embargoed branch is for a generation that is OSS when its release is made public, on the date of its train. The workflow reads the generation (`7.0.x`) from the Spring projects API (`https://api.spring.io/projects/spring-security/generations`) in the plan job, and fails with **OSS support of 7.0.x ended** if its `ossSupportEndDate` is before that date (the last day counts). Once a generation is commercial, replace its frozen and active branches with one `embargoed/lts/<generation>` branch. A long-term support branch is not checked.

### A long-term support embargoed branch

`embargoed/lts/<generation>` (`embargoed/lts/5.8.x`, `5.8.30-SNAPSHOT`) is commercial: it is merged into other long-term support branches only, and releases its own version. A push builds `release/5.8.30`, from the pushed commit, and the snapshot branch `embargoed/5.8.30-SNAPSHOT`: the pushed commit with the snapshots of the dependencies that have joined the train (no issues). It is a plain `-SNAPSHOT`, as a hotfix has, and never an internal one: only OSS has `-INTERNAL-SNAPSHOT`, because OSS publishes a regular snapshot without the fixes for vulnerabilities, and a commercial snapshot (a hotfix or an LTS version) has them. The commits of the release are the ones of a frozen branch (an issue for each dependency that the release train asks for, and then `Release 5.8.30`), but the milestone `5.8.30` and the issues are in the **commercial repository**, since there is no OSS release. It is deployed to `Spring Enterprise`.

Its train is named by the **description of its milestone** in the commercial repository, with a line `Release Train: <name>` (the name of the branch of the train, `Release Train: 2026.10.22`): the train is the source of truth. The due date of the milestone cannot name it, because an LTS milestone is due on the **commercial general availability** of its train, not on the date of the train: `5.8.29` is in the train `2026.10.22`, whose commercial general availability is `2026-11-19`, and `2026.11.19` is the name of another train (its commercial general availability is `2026-12-24`). The due date of the milestone is set to the commercial general availability of that train (the notice **Milestone due date** says so), as for a hotfix. A milestone whose description names no train fails the run (**Work out the release version**), and the summary says to add the line. The release joins the train with the destination `Spring Enterprise`, and takes the release versions of the train (it prefers no hotfix versions of the dependencies).

### The hotfix is built on the release

A hotfix is the release plus the fixes of the active embargoed branch, and each of its two branches is based on the same kind of branch of the release: the snapshot branch of a hotfix starts with the snapshot of the release, `embargoed/7.0.1-INTERNAL-SNAPSHOT`, **merged in** (a merge commit, `Merge embargoed/7.0.1-INTERNAL-SNAPSHOT into embargoed/7.0.1.1-SNAPSHOT`), and the release branch of the hotfix, `release/7.0.1.1`, is started at the pushed commit, and has the release, `release/7.0.1`, merged in (`Merge release/7.0.1 into release/7.0.1.1`). The release branch is not built on the snapshot branch, which has the snapshots of the dependencies. The action `merge-release` does both merges.

- **The active embargoed branch has nothing that the frozen one lacks**: a hotfix is the fixes of the active embargoed branch on the release, so with no fixes there is no hotfix. The workflow compares the active branch with the frozen one of its generation (`embargoed/frozen/7.0.x` for `embargoed/active/7.0.x`), the changes of the active branch since their merge base, as `git diff frozen...active` gives them (the action `compare-branches`). The merge of the frozen branch into the active one has no changes of its own, so right after the merge forward there is nothing to build: the run succeeds, with the notice **Nothing to build**, and builds neither the snapshot branch nor `release/7.0.1.1`. This is decided first, before the milestone of the hotfix is looked for, so it needs no milestone then. If the frozen branch does not exist, there is nothing to compare with: the hotfix is built, with the notice **No frozen embargoed branch**.
- **The release does not exist yet** (the frozen embargoed branch has not been pushed, so nothing built it): the run warns (**No release to build the hotfix on**, and **No snapshot to build the hotfix snapshot on** for the snapshot of the release, which is thrown away when the release is done), and the hotfix is built from the active embargoed branch alone. It is built on the release the next time that the active embargoed branch is pushed after the release exists, for example when the frozen embargoed branch is merged into it. A hotfix that was built before has an issue for every dependency, and the dependencies that have no hotfix do not need theirs any more: they stay open, and are closed by hand.
- **Both sides changed the same lines**: the side of the active embargoed branch is kept, and a notice (**Changed on both sides**) says which files both changed. A conflict that cannot be settled like that, a file that one side deleted and the other changed, fails the run, and says to merge the branch it names (`release/7.0.1` or `embargoed/7.0.1-INTERNAL-SNAPSHOT`) into the active embargoed branch by hand (the merge forward), and push it.
- **The versions of the dependencies come with the release**, so a dependency that has no hotfix version in the release train is left at the version that the release has: no snapshot, no commit and no issue for it in the hotfix. The hotfix ends with the same versions as it would without the merge, and has an issue for each dependency that does have a hotfix.
- A release that is built again later is only picked up by the hotfix the next time that the active embargoed branch is pushed.

The **milestone** of the release, and the **issues** of its dependency updates, are in the **OSS repository** for a release, which is public. A hotfix is only released from the commercial repository, so its milestone (`7.0.1.1`, with a due date) and the issues of its dependency updates are in the **commercial repository**: a milestone in the OSS repository would tell everyone that there is a hotfix. The issue of a commit (`Closes gh-123`) is the one of the repository that has the milestone. The milestone is looked for first, in the plan job, and only if there is something to build. If it does not exist, the workflow creates it (the token `RELEASE_AUTOMATION_TOKEN` must be allowed to create milestones in the OSS repository and in the commercial one), and for a frozen or LTS version ends with the notice **Milestone created** and builds nothing: the summary says what to set (see Troubleshooting). A milestone that exists without a due date (or, for an LTS version, without the `Release Train:` line) is an error, and its summary says what to change.

**Joining the train.** When the branches are pushed, the release joins the train by running the workflow `Release Train - Join` (`release-train-join.yml`) of **the project** on the release branch `release/7.0.1`, with the destination (`Maven Central` for a frozen embargoed branch, `Spring Enterprise` for a hotfix, which is commercial), the train branch and the release train repository. That workflow has the token for the release train, runs `Join` there with the commit of the release branch, and waits for it, so a failed join is in its run, which the summary links to. The commercial repository needs that workflow on its branches (the workflow generator makes it). It joins only if the train exists and does not have the release yet, so a run that is made again does not join twice. The due date of the milestone of a hotfix or of an LTS version is first set to `schedule.publication.commercial-general-availability` of its train (at noon UTC), if it is another or has none: the notice **Milestone due date** says so. The train of a hotfix is the one of its OSS equivalent, so the due date of the milestone of `7.0.1` in the OSS repository decides it. If that milestone does not exist, the run ends with the notice **No milestone**, and builds nothing (it is the milestone of the frozen branch, which creates it). If it has no due date, the run fails, after the milestone of the hotfix was created. To join after a milestone was fixed, run the workflow by hand on the embargoed branch (`workflow_dispatch`).

Which versions of the dependencies the release needs comes from the **release train**, a repository with a branch for each release date (`2026.11.19`) that has `release-versions.json` and `train.yml`. The branch is the date that the milestone of the release is due. For a hotfix it is the date that the OSS milestone of the release it fixes is due (`7.0.1` for `7.0.1.1`): the due date of the hotfix is when it is commercially available, after the train that builds it. If the description of the milestone of a hotfix names a train (`Release Train: 2026.10.22`), that is the train instead, and it is the only way for an LTS version, which has no OSS milestone. If that train has not been created, the branches are built without the dependency updates. If the release is **ready** in the train, it is not changed: the run fails and says what to do.

### The release train

The release train repository (`spring-io/release-train`, or `RELEASE_TRAIN_REPOSITORY`) has a branch for every release date (`2026.11.19`), with two files:
- `release-versions.json`: the versions of every project of the train (`{ "spring-framework": ["7.0.10", "7.0.10.1"], ... }`).
- `train.yml`: its state, its schedule (`schedule.publication.commercial-general-availability` is the date that a hotfix is available) and, for every release, the commit hashes of the steps that it went through (`joined`, `ready`, `built`, `tested`).

The workflow reads the branch of the date, so the due date of the milestone of a release must be a date of a train. The milestone of an LTS version (commercial) names the train in its description, `Release Train: 2026.10.22`, and its due date follows the train. A hotfix has the train of the OSS version that it fixes. A train that has not been created is not an error, and neither is a release that has not joined. It does not change a release that is **ready**. The dependency updates are only the ones of the versions that **have joined** the train.

## What a run does, in order

**The plan job** decides, and builds nothing:
1. Reads the version of `gradle.properties`, and decides what to build from the branch: frozen, active (a hotfix) or LTS.
2. For an active branch, compares it with the frozen branch of its generation: with no changes of its own, it ends with **Nothing to build**.
3. For a hotfix, looks for the milestone of the version it fixes in the OSS repository (that is the date of its release train), and for a `.0` version it is only built if the next release is the GA.
4. Looks for the milestone of the release. A release is in the OSS repository, a hotfix or an LTS version in the commercial one. If there is none, it is created: **Milestone created** and nothing is built, for a frozen or LTS version. If it is not in a train: the run fails. Reads the release train that its description names (`Release Train: 2026.10.22`), which an LTS version needs: the run fails without it.
5. For frozen and active branches, checks that the generation is still OSS on the date of the train.

**The build job** builds the branches, in one checkout, and pushes them at the end, both or none:
1. Reads the release train: the one that the description of the milestone names, or else the one of the date (**No release train**, a notice, if it has not been created: the dependency steps are skipped, and nothing joins). For a hotfix or an LTS version, sets the due date of its milestone to the commercial general availability of the train.
2. Fails if the release is **ready** in the train already.
3. Builds the snapshot branch: from the pushed commit, for a hotfix with the snapshot of the release merged in and the commercial license applied. Its dependencies are snapshots of the versions that have joined the train (`-SNAPSHOT` for a hotfix or an LTS version, `-INTERNAL-SNAPSHOT` for a frozen branch), with no issues: the branch is thrown away or replaced.
4. Builds the release branch: from the pushed commit, for a hotfix with the release merged in and the commercial license applied. It works out the versions of the dependencies from the train, **creates an issue, with no body, for each update that has none**, makes one commit for each (`Update spring-framework to 7.0.10`, with `Closes gh-123` of that issue), and then the commit of the version, `Release 7.0.9`. The issues are in the milestone of the release, in the OSS repository for a release, and in the commercial repository for a hotfix or an LTS version (the milestone is there, and a milestone in the OSS repository would tell everyone about a hotfix). Their title is `Update <dependency> to <version>`, with the label `type: dependency-upgrade`. The issue of a hotfix or of an LTS version is **closed when it is created**, as its commit is made in the same run. The issue of a release is left open, and its commit closes it when it is merged. An issue of an update that is not in the train on a later run (a dependency that left it, or has another version now) is commented on and taken out of the milestone.
5. Pushes the branches, and the summary of the run has them, with the milestone and the release train, and says how each branch was created and what it has that OSS lacks (see [The summary of the run](#the-summary-of-the-run)).
6. Joins the release train: runs the workflow `release-train-join.yml` of the project on the release branch, with the destination (`Maven Central` for a frozen branch, `Spring Enterprise` for a hotfix or an LTS version), unless the release is in `train.yml` already. A join that fails is in the run of that workflow, which the summary links to.

**Which versions the updates take** (`map-train-versions`): for each entry of `[versions]` named after a project of the train, the newest version of the train of the same generation (`7.0.x`) that has joined it (a hotfix version only for a hotfix, never for a release or an LTS version). It never goes down: a catalog that has a newer version than the train fails. A version that has the value already is left alone, so a run that is made again changes nothing twice. An issue that exists is used, open or closed, and is not created again. See the READMEs of `map-train-versions`, `ensure-dependency-issues` and `update-versions`.

## The summary of the run

The summary of the run (the page of the run on GitHub) says what the push created and how, so that nobody has to read the history of the branches to see what a hotfix has. It begins with the two branches that the push creates and uses for releasing: the snapshot, and the release, which are pushed together. Under it is the release train, and a table of the branches with the number of commits that OSS lacks. Then each branch has a section, the snapshot first, as it is built first:

- **How it was created**: the steps that the run made, in order, each with its commit: it was started at the pushed commit, the merge of the branch that a hotfix is based on (or that it was skipped, because that branch does not exist), the commercial license, the version, and the dependency updates with their issues.
- **Commits not in OSS**: the commits of the branch that OSS does not have, the oldest first, each with its subject and a link to its commit. Merge commits are not listed. A list has 50 at most, then `and N more` with a link to the compare view. Under the list is the `git log` command that prints it, in a clone of the repository, with no limit. What a branch is compared with:
  - a **hotfix**: the OSS version that it is based on (the tag `7.0.9` for `7.0.9.1`). That release is not public yet while it is embargoed, so there is no such tag: the hotfix is compared with the branch that it is based on, `release/7.0.9` for the release and `embargoed/7.0.9-INTERNAL-SNAPSHOT` for the snapshot, and the heading says so.
  - **a frozen or a long-term support** branch: the branch of OSS of its generation (`7.0.x`).
  - if OSS cannot be read, or has no such branch, with the pushed commit: the commits that the run made. The heading says why, and a warning says that OSS could not be read (the run goes on).
- **All changes in this release** (the release branch only): the number of commits since the release before it (the greatest version below it: `7.0.8` for `7.0.9`, `7.0.9` for `7.0.9.1`, from the tags of OSS and the release branches), a link to the compare view, and the `git log --no-merges` command that lists them.

Under the table are the commands that get a clone ready for these: OSS as a remote, and a fetch of the branches that were pushed. For `embargoed/frozen/7.0.x` it reads, for example:

```
This push creates two branches that are used for releasing 7.0.9: embargoed/7.0.9-INTERNAL-SNAPSHOT, the snapshot, and release/7.0.9, the release.

release/7.0.9: How it was created
1. Started from the pushed commit 87174e9 of embargoed/frozen/7.0.x.
2. Updated 1 dependency, with its issue: 95be8d4 (reactor 2025.0.9, Closes gh-20026).
3. Set the version to 7.0.9 (50d0b06).

Commits not in OSS 7.0.x
- 95be8d4 Update reactor to 2025.0.9
- 50d0b06 Release 7.0.9
    git log --oneline --no-merges --reverse oss/7.0.x..origin/release/7.0.9

All changes in this release
44 commits since 7.0.8 (60 with the 16 merge commits)
    git log --oneline --no-merges 7.0.8..origin/release/7.0.9
```

It is made by `push-branches`, see its README: the steps are read from the commits that the run made on the pushed commit, by the subjects that the actions give them.

## Calling it

The project has a workflow that the push of the embargoed branches triggers, and that calls this one. The trigger, the concurrency and the permissions are the project's: a called workflow cannot widen the permissions of the caller.

```yaml
name: release-branches

on:
  push:
    branches:
      - "embargoed/frozen/**"
      - "embargoed/active/**"
      - "embargoed/lts/**"
  # Run it by hand on an embargoed branch (for example after the due date of a milestone was set):
  # it builds the branches again from the head of the branch, and joins the train if it has not.
  workflow_dispatch:

permissions:
  contents: read

# One run at a time for a branch, and the newest wins: a run only pushes at the very end,
# once, and what it creates on the way (the issues) is found again by the next run.
concurrency:
  group: release-branches-${{ github.ref }}
  cancel-in-progress: true

jobs:
  release-branches:
    uses: spring-io/spring-security-actions/.github/workflows/release-branches.yml@<ref>
    with:
      runs-on: ${{ vars.UBUNTU_RUNS_ON }}
      release-train-repository: ${{ vars.RELEASE_TRAIN_REPOSITORY }}
      snapshot-suffix-overrides: ${{ vars.SNAPSHOT_SUFFIX_OVERRIDES }}
    secrets:
      RELEASE_AUTOMATION_TOKEN: ${{ secrets.RELEASE_AUTOMATION_TOKEN }}
```

| Input or secret | What it is |
|---|---|
| `runs-on` (input) | The runner of the jobs, a label. `ubuntu-latest` if it is not given, or empty. A private or internal repository should give the label of the runners of its organization (`ubuntu22-2-8`, in the runner group `spring-enterprise-builds`, for the commercial repositories, which keep it in the variable `UBUNTU_RUNS_ON`): GitHub-hosted runners are billed to the account, and GitHub refuses the jobs ("The job was not started because recent account payments have failed or your spending limit needs to be increased") if it cannot pay. |
| `release-train-repository` (input) | The release train repository, `owner/repo`. `spring-io/release-train` if it is not given, or empty. |
| `RELEASE_AUTOMATION_TOKEN` (secret) | The token below. A reusable workflow gets only the secrets that its caller gives it. |

`<ref>` is a tag or a commit of this repository. Pin a commit, as for any action that has access to a token. The workflow calls the actions of this repository at a commit that is written in it, each with a comment that names the tag. That commit is not the one of the workflow: it is the one that the actions were released at, so a caller that pins a commit of the workflow gets exactly the actions that it names.

The workflow runs from the pushed branch, so the workflow of the project must be on every embargoed branch: it comes with the merges forward.

## The secret, the variable, and the tokens

The caller needs one secret and one variable, which are settings of the **commercial repository**:

| Name | Kind | What it is |
|---|---|---|
| `RELEASE_AUTOMATION_TOKEN` | secret | A token that can read the release train repository, run the workflow `Release Train - Join` of the commercial repository (Actions: Read and write), create issues in the OSS repository, read the milestones and create issues in the commercial repository (for a hotfix), and push to the commercial repository. See below. |
| `SNAPSHOT_SUFFIX_OVERRIDES` | variable | Optional. Which snapshots of the dependencies are `-SNAPSHOT` or `-INTERNAL-SNAPSHOT` instead of what the kind of the release gives. The caller gives it as the input `snapshot-suffix-overrides`. One rule per line: `<project>=<suffix>` for every version of a project, or `<project>@<version>=<suffix>` for a version of the project in the release train (`7.0.10.1`, a hotfix too) or for its generation (`7.0.x`). The most specific rule wins. A rule that cannot be read, or for a project that is not in the train, fails the run. See `map-train-versions`. |
| `RELEASE_TRAIN_REPOSITORY` | variable | The release train repository, `owner/repo`. The caller gives it as the input `release-train-repository`. If it is not set, the release train is `spring-io/release-train`. |

Everything that can be done with the token of the workflow itself, `GITHUB_TOKEN`, is: the permissions of the workflow are `contents: read`, and it reads the milestones of the OSS repository, which is public. It cannot read the milestones of the commercial repository, which is private (that needs `issues: read`, and a called workflow cannot widen the permissions of its caller). `RELEASE_AUTOMATION_TOKEN` is only used where `GITHUB_TOKEN` cannot:

| Step | Token | Why |
|---|---|---|
| the checkout, and the push of the branches | `RELEASE_AUTOMATION_TOKEN` | it writes to the commercial repository, and a push with it **runs workflows** (the workflows of the project that build the new branches and publish the snapshots). A push with `GITHUB_TOKEN` runs none. |
| `load-train` | `RELEASE_AUTOMATION_TOKEN` | the release train repository is private, and is another repository than this one. |
| `align-milestone` (a hotfix) | `RELEASE_AUTOMATION_TOKEN` | it writes a milestone of the commercial repository, which is this one, and `GITHUB_TOKEN` has `contents: read` only. |
| `join-train` | `RELEASE_AUTOMATION_TOKEN` | it runs a workflow of this repository, and `GITHUB_TOKEN` has `contents: read` only. |
| `ensure-dependency-issues` | `RELEASE_AUTOMATION_TOKEN` | the issues of a release are in the OSS repository, which is another repository than this one, and the issues of a hotfix are in this one, with its milestone. |
| `compute-release-version` (in the plan job) | `GITHUB_TOKEN` for a release, `RELEASE_AUTOMATION_TOKEN` for a hotfix | the milestones of a release are in the OSS repository, which is public. The milestone of a hotfix is in the commercial repository, which is private. |

### What the token needs

| Repository | What for | Fine-grained token | Classic token |
|---|---|---|---|
| the release train repository | read its branches and files | **Contents: Read-only** | `repo` |
| the OSS repository | read its milestones, create and read its issues (for a release) | **Issues: Read and write** | `repo` (`public_repo` for a public repository) |
| the commercial repository | fetch it, and push the branches; run its workflow `Release Train - Join` (`join-train`); read and set the due date of its milestones (a hotfix, `align-milestone`), create and read its issues (for a hotfix) | **Contents: Read and write**, **Actions: Read and write** and **Issues: Read and write** (issues include milestones) | `repo` (it includes running workflows: no `workflow` scope is needed, that one is for changing workflow files) |

**A fine-grained token has one owner.** When the three repositories are in one account or one organization (as in the practice repositories), one fine-grained token with those three permissions does. When they are not (the real ones: the release train is in `spring-io`, the others in `spring-projects`), a fine-grained token cannot cover them, and you need a classic token, whose `repo` scope covers every repository that its user can access. Make it the token of a machine user that has the access that it needs, and not that of a person. The scopes are broad, and are the reason to keep the secret in the commercial repository only.

### Create a classic token

1. Go to https://github.com/settings/tokens and choose **Generate new token (classic)**.
1. Give it a name (`release automation`) and an expiration, and select the scope `repo`. That is all: it reads and writes the contents, issues and milestones, and runs the workflow `Release Train - Join`, of every repository that its user can access (the user needs write access to the commercial repository, issues access to the OSS repository, and to be able to read the release train repository).
1. Generate it, and copy it. It is shown once.
1. For an organization that uses SAML single sign-on, choose **Configure SSO** next to the token and authorize the organizations of the repositories. Without it the token cannot read them.

### Create a fine-grained token

1. Go to https://github.com/settings/personal-access-tokens and choose **Generate new token**.
1. Choose the **resource owner** that owns the three repositories.
1. Choose **Only select repositories**, and select the release train repository, the OSS repository and the commercial repository.
1. Under **Repository permissions**, set **Contents** to **Read and write** (that is for the commercial repository, and reads the release train too), **Issues** to **Read and write** (the OSS repository, for a release, and the commercial repository, for a hotfix, with its milestones), and **Actions** to **Read and write** (runs the workflow `Release Train - Join` of the commercial repository). Metadata (read) is added by itself.
1. Generate it, and copy it.

### Store it

In the **commercial repository**, as a secret named `RELEASE_AUTOMATION_TOKEN`: **Settings**, **Secrets and variables**, **Actions**, **New repository secret**. Or with `gh`, which reads the secret from standard input, so that it is not in your history:

```shell
gh secret set RELEASE_AUTOMATION_TOKEN --repo your-organization/spring-security-commercial
gh variable set RELEASE_TRAIN_REPOSITORY --body spring-io/release-train --repo your-organization/spring-security-commercial
```


## When it fails

Every message says what went wrong. These are the usual ones:

| The run fails at | What to do |
|---|---|
| **Stop if the release is ready already** | The release is ready in the release train, and is not changed any more. To release the next version instead: set the version of `gradle.properties` to the next version in the OSS repository, and merge forward. |
| The run ends with the notice **Milestone created** (or **No milestone**, for the OSS milestone of a hotfix), or fails with `has no due date` or `does not name its release train`, and builds nothing | The milestone of the version does not exist, or is not in a release train. The summary of the run says what to do for the branch. A **frozen** branch (OSS): create the milestone in the OSS repository, with a due date that is the date of the release train. An **LTS** branch (commercial): create it in the commercial repository, with the line `Release Train: 2026.11.19` in its description (the due date is set from the train). An **active** branch (a hotfix, `7.0.1.1`): give the milestone of the OSS version that it fixes (`7.0.1`, in the OSS repository) a due date that is the date of the train, and create the milestone of the hotfix in the commercial repository, with any due date: it is set to the commercial general availability of the train (`7.0.8.1` is due on the commercial availability of the train `2026.10.22`, `2026-11-19`). Then push again, or run the workflow by hand. |
| **Work out the release version**: `does not name its release train` | The milestone of an LTS version needs a line in its description: `Release Train: 2026.10.22` (the branch of its train in the release train repository). Add it, and run the workflow again. A name that is not `YYYY.MM.DD`, or two lines with different trains, fail too. |
| **Work out the release version**: `has no due date` | Set the due date of the milestone of a release. It is the date of the release train, `2026-11-19` for the train `2026.11.19`. A hotfix needs none: it is set from the train. |
| **Set the due date of the milestone**: `No commercial-general-availability` | The train has no `schedule.publication.commercial-general-availability`. Add it to the train, and run the workflow again. |
| **Check that the generation is still supported as OSS**: `OSS support of 7.0.x ended` | The generation is commercial by the date of the train. Replace `embargoed/frozen/7.0.x` and `embargoed/active/7.0.x` with `embargoed/lts/7.0.x`. |
| **Join the release train**: `Could not run release-train-join.yml` | The branch has no `release-train-join.yml`, or the token cannot run workflows of the commercial repository: it needs Actions: Read and write on it (fine-grained), or `repo` (classic). A join that fails in the workflow itself is in the run of `Release Train - Join` that the summary links to. |
| **Read the release train**: `404 ... cannot read it` | The token cannot read the release train repository, or `RELEASE_TRAIN_REPOSITORY` is wrong. A train that has not been created is not an error: the branches are built without the dependencies. |
| **Merge the release into the hotfix**: `could not be merged` | The active embargoed branch and the release changed a file in a way that the side of the active embargoed branch cannot settle. Merge the branch that the message names (`release/7.0.1` or `embargoed/7.0.1-INTERNAL-SNAPSHOT`) into the active embargoed branch by hand (the merge forward), push it, and the hotfix is built again. |
| **Merge the release into the hotfix**: warning `No release to build the hotfix on` | Not a failure: the release has not been built. Push the frozen embargoed branch, and push the active embargoed branch again. |
| **Make sure that there are issues**: `403` | The token cannot create issues in the repository that the message names, the OSS repository for a release and the commercial repository for a hotfix: see what it needs. |
| **Work out the versions of the dependencies**: `is newer than the ... of the train` | The version catalog has a newer version of a dependency than the release train. Something is out of order: look at it. The action does not downgrade. |
| **Set the version of the release**: `git does not know who commits` | git has no `user.name` and `user.email`. The workflow sets them, so this is a change to the workflow. |
| **Push the branches**: rejected | The token cannot push to the commercial repository, or a branch is protected against a forced push. Nobody commits to the branches that it builds, so they can be forced. |

A run that was cancelled by a newer push of the same branch is not a failure: the newer run builds the branches.

## What a project needs

- The version catalog, `gradle/libs.versions.toml`, names a version after the project of the release train that releases it (`spring-framework = "7.0.9"`), in its `[versions]` section, one on a line. A library refers to it with `version.ref`.
- The OSS repository has the milestones of the releases, with their due dates (at noon UTC). The commercial repository is named like it, with `-commercial`, has the embargoed branches, and has the milestones of the hotfixes (also with a due date, the date that the hotfix is commercially available).
- `apply-commercial-license` has the commercial license for a hotfix: give another with `license-file`. It changes the Apache headers (Java, AspectJ, Groovy, Kotlin, JavaScript, `.gradle`, `.properties`, `.xml` and `.tld`: `header-files`) to the Broadcom one with **one year for the project**, the oldest of its copyright (`year` gives another), rewrites `etc/checkstyle/header.txt` to match if the project has one, replaces the `LICENSE*` file of the root (`license-target`), and sets the license of the published POM to the Broadcom Foundation License. The last one needs a `build.gradle` or `build.gradle.kts` in the root: it applies `gradle/broadcom-license.gradle` from there, so it works whether or not the build reads `gradle/init.d` (`run-gradle` does, a plain `./gradlew` does not). Other copyright holders of a file are kept. Files that a `checkstyle-suppressions.xml` skips entirely (third-party code) are left alone.
- The actions are written for Node 24, as the actions of [spring-release-actions](https://github.com/spring-io/spring-release-actions) are. [The README](../README.md) says how to build and test them.
- GitHub is retiring the version `2022-11-28` of its API, which is the one that the actions use. It is a warning for now: see `ensure-dependency-issues`.
