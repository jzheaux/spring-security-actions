# The code freeze

The code freeze moves every branch of a project on to its next development version, merges the history forward, marks the releases ready in the release train, and pushes, while `release/<version>` (built by [the release automation](release-branches.md)) does the releasing. It is run by hand from the Actions tab of the **commercial** repository of the project, and freezes only that project.

It runs with a **dry run on by default**: it plans, makes the merges and the version commits in a clone of the runner, checks that the pushes would be accepted, and says in the summary what it would do. Nothing is marked ready or pushed.

## Setup checklist

1. **The caller**, `.github/workflows/code-freeze.yml`, on the embargoed branches of the commercial repository (it comes with the merges forward). See [the caller](#the-caller).
2. **The stub**, a `code-freeze.yml` on the default branch of the commercial repository (`main`), which never receives the embargoed merges. See [the stub](#the-stub-on-the-default-branch).
3. **The secret** `RELEASE_AUTOMATION_TOKEN` in the commercial repository, with the permissions of [the token](#the-token), and the variables `UBUNTU_RUNS_ON` (the runners of the organization) and, if it is not `spring-io/release-train`, `RELEASE_TRAIN_REPOSITORY` (the release train repository, `owner/repo`: the caller gives it as the input `release-train-repository`, and an empty value is the default).
4. **The workflow `release-train-ready.yml`** on the release branches (the workflow generator makes it, as it does `release-train-join.yml`).
5. For each release of the freeze, **`release/<version>` has been built and has joined the release train**: the release workflow does both when the embargoed branch is pushed.

## What it does

1. **Plan** (nothing is changed). The branches are the OSS generations of the Spring projects API (`7.0.x`, `7.1.x`, `main`) and, for long-term support, the commercial ones (`6.4.x`, `6.5.x`), unless the inputs `branches` and `lts-branches` say otherwise. The generations are in the order of their release, which is the order of the merges (Spring Session's `2021.2.x` comes before `3.4.x`). A long-term support generation is the branch `embargoed/lts/<generation>`, or, if its name is not the name of its branch, the `embargoed/lts/*` branch that has a version of the generation (`2021.2.x` is `embargoed/lts/2.7.x`); its OSS branch is not read. For each branch it works out the next version, and the release it needs. **Everything that stops the freeze is listed at once**, and the run fails before anything changes:
   - a `release/<version>` does not exist or has not joined the release train, or the train does not exist (one that is **ready already** is not a problem: it is skipped, see below),
   - a branch does not exist, or the OSS, frozen and active branches of a generation have different versions,
   - a `.0` version has no open milestone,
   - the milestone of a hotfix (`7.0.5.1`) does not exist in the commercial repository (the release workflow creates it),
   - the override is wrong (a branch that is not of that kind, the wrong order, a gap in the middle, a duplicate).
2. **Apply**, in a clone. The OSS branches first, from the OSS repository alone; then the embargoed ones; then each frozen branch is fast forwarded to its active branch.
3. **Check**: nothing commercial goes to OSS, and both pushes would be accepted. **A dry run ends here.**
4. **Ready**: `release-train-ready.yml` runs on each `release/<version>`, and the freeze waits for it. A release that is ready in the train already is skipped, and its branches are bumped all the same. Ready cannot be undone, so it comes after everything that can be checked, and before any bump is pushed.
5. **Push**: the commercial repository, then OSS, each in one atomic push without force.
6. **Milestones**: [close-milestones](../close-milestones/README.md) closes the milestone of each release, in the OSS repository for the OSS and frozen releases, and in the commercial one for a hotfix and for long-term support. A milestone with open issues is closed all the same, and the summary has the count. The milestone of a **hotfix that has no issues**, open or closed, is **deleted**. This is last, so a failed push leaves them open, and a dry run says what it would do and does nothing.

### The next version

The last segment plus one: `7.0.5-SNAPSHOT` becomes `7.0.6-SNAPSHOT`, in the commit `Next Development Version (7.0.6-SNAPSHOT)`. A `.0` version is the exception, as it is released as milestones and release candidates first and its `gradle.properties` is always `x.y.0-SNAPSHOT`:

| `gradle.properties` now | Milestones | Becomes | Commit |
|---|---|---|---|
| `7.0.5-SNAPSHOT` | any | `7.0.6-SNAPSHOT` | `Next Development Version (7.0.6-SNAPSHOT)` |
| `7.2.0-SNAPSHOT` | `7.2.0-M1` to `7.2.0-RC1`, no `7.2.0` | `7.2.0-SNAPSHOT` | none |
| `7.2.0-SNAPSHOT` | `7.2.0` exists (open or closed) | `7.2.1-SNAPSHOT` | `Next Development Version (7.2.1-SNAPSHOT)` |

A branch whose version stays has no commit, and is merged all the same. A hotfix milestone (`7.2.0.1`) does not count. The milestones are read from the OSS repository, and from the commercial one for long-term support. The freeze creates none: the release workflow does.

### The merges

Across (a generation into the next one, `merge(ours): 7.0.x into 7.1.x`) keeps the version of the **target**. Down (OSS into frozen, frozen into active, `Merge branch '7.0.x' into 7.0.x`) takes the version of the **source**, so the OSS, frozen and active branches of a generation end with one version. No message names an embargoed branch, as a frozen branch becomes public. Long-term support branches merge into each other only (`6.4.x` into `6.5.x`), never into 7.x or `main`. [apply-freeze](../apply-freeze/README.md) has the order.

### Nothing commercial reaches OSS

This is required, and it is enforced in code, not left to the order of the steps:

- OSS is worked on in `refs/freeze/oss/*`, made from the OSS repository alone, and no OSS branch is ever the commercial branch of the same name (`main` is a branch of both).
- Before anything is marked ready or pushed, [push-freeze](../push-freeze/README.md) checks every commit that the OSS push would send: it must be one that the freeze made, not be in the commercial repository, have no `embargoed` in its message, and be a version commit that changes only `gradle.properties`, or a merge of two commits that are in OSS. If one is not, the run fails with **Commercial code would reach OSS**.
- The OSS push has an explicit refspec for each branch, never a force, a tag or `--all`.
- The freeze refuses to run unless the repository that runs it is a commercial one (its name ends with `-commercial`).
- This workflow never fast forwards OSS to a frozen branch: that is part of the release, not of the freeze.

## The caller

A workflow of the commercial repository, run by hand. The run name has the release train. Call the workflow at the commit of a tag:

```yaml
name: "Code Freeze"
run-name: "${{ inputs.release-train }}: Code Freeze${{ inputs.dry-run && ' (dry run)' || '' }}"
"on":
  workflow_dispatch:
    inputs:
      release-train:
        description: "Release train, for example 2026.11.19"
        required: true
        type: string
      branches:
        description: "OSS branches to freeze, oldest first (7.1.x,main). Empty: all the OSS generations"
        required: false
        type: string
      lts-branches:
        description: "Long-term support generations to freeze, oldest first (6.4.x,6.5.x). Empty: all of them"
        required: false
        type: string
      dry-run:
        description: "Only log what would happen: nothing is pushed or marked ready"
        default: true
        type: boolean
permissions:
  contents: read
jobs:
  code-freeze:
    uses: spring-io/spring-security-actions/.github/workflows/code-freeze.yml@<the commit of a tag>
    with:
      release-train: ${{ inputs.release-train }}
      branches: ${{ inputs.branches }}
      lts-branches: ${{ inputs.lts-branches }}
      dry-run: ${{ inputs.dry-run }}
      runs-on: ${{ vars.UBUNTU_RUNS_ON }}
      release-train-repository: ${{ vars.RELEASE_TRAIN_REPOSITORY }}
    secrets:
      RELEASE_AUTOMATION_TOKEN: ${{ secrets.RELEASE_AUTOMATION_TOKEN }}
```

In the Actions tab, **Run workflow** has the release train, the two branch lists, and the dry run, ticked. A run is listed as `2026.11.19: Code Freeze (dry run)`.

## The stub on the default branch

GitHub lists a workflow that is run by hand only if its file is on the default branch. The default branch of the commercial repository, `main`, never receives the embargoed merges, so the caller would not be listed. Put a file with the **same name and the same inputs** on `main`, whose only job fails with a hint:

```yaml
name: "Code Freeze"
run-name: "${{ inputs.release-train }}: Code Freeze (use an embargoed branch)"
"on":
  workflow_dispatch:
    inputs:
      release-train:
        description: "Release train, for example 2026.11.19"
        required: true
        type: string
      branches:
        description: "OSS branches to freeze, oldest first (7.1.x,main). Empty: all the OSS generations"
        required: false
        type: string
      lts-branches:
        description: "Long-term support generations to freeze, oldest first (6.4.x,6.5.x). Empty: all of them"
        required: false
        type: string
      dry-run:
        description: "Only log what would happen: nothing is pushed or marked ready"
        default: true
        type: boolean
permissions:
  contents: none
jobs:
  stub:
    name: "Choose an embargoed branch"
    runs-on: ubuntu-latest
    steps:
      - name: "Choose an embargoed branch in 'Use workflow from'"
        run: |
          echo "::error::This is the stub of the default branch, which makes the workflow show in the Actions tab. Choose a branch that has the real Code Freeze workflow, for example embargoed/active/main, in 'Use workflow from'."
          exit 1
```

Running the stub by accident changes nothing. Choose a branch that has the real caller in **Use workflow from**. It has to be tried once that the form and the run use the file of the branch that is chosen.

## The token

`RELEASE_AUTOMATION_TOKEN` is the one of the release workflow, and needs more for the freeze:

| Where | What for | Fine-grained token | Classic token |
|---|---|---|---|
| the commercial repository | check out, push the branches, run `release-train-ready.yml`, close and delete its milestones | **Contents: Read and write**, **Actions: Read and write**, **Issues: Read and write** | `repo` |
| the OSS repository | fetch, push the branches, close its milestones | **Contents: Read and write**, **Issues: Read and write** | `repo` |
| the release train repository (`spring-io/release-train`, or `RELEASE_TRAIN_REPOSITORY`) | read the train | **Contents: Read** | `repo` |

Both repositories must let the token push to their protected branches (a bypass in the ruleset), as the freeze pushes the version commits and the merges directly.

## Reading a run

The summary has the versions of every branch, the releases marked ready with a link to each run, the merges in order, the pushes with the OSS leak check, and the milestones that were closed or deleted. A dry run says so in the title.

| What the run says | What to do |
|---|---|
| `release/<version> has not joined the release train` | The release workflow joins it when its embargoed branch is pushed. Push it, or leave the branch out of `branches`. |
| `release/<version> does not exist` | The release branch is built from the embargoed branch when it is pushed. Push it and wait for the release workflow. |
| `must have one version` | Make the OSS, frozen and active branches of the generation agree. |
| `has no open milestone` | A `.0` version needs an open milestone (`7.2.0-M2`). The release workflow creates the missing ones. |
| `skips 7.1.x, which is in the middle of the chain` | Leave out the oldest or the newest branches, and not one in the middle. |
| **Merge conflict** in a file | A fix was made on a branch and not merged forward, and it conflicts. Merge by hand, then run the freeze again. Nothing was pushed. |
| **Not a fast forward** | The frozen branch could not be fast forwarded to the active one. Nothing was pushed. |
| **Commercial code would reach OSS** | Do not push. The message lists the commits. The cause is a bug in the freeze or a changed history: nothing was pushed or marked ready. |
| `Pushing the OSS branches would be refused` (the check) | Someone pushed to an OSS branch since the plan. Run it again. |
| `The commercial branches were pushed, and the OSS branches were refused` | The commercial push worked, and OSS did not. The message has the command to push the OSS commits by hand. Do not run the freeze again: it would bump twice. |
| `the milestone 7.0.5.1 of the hotfix does not exist` | The release workflow creates it when the active branch is pushed. Push it, or leave the branch out of `branches`. |
| `Milestones not closed` | The freeze is done. Close the milestones that the message lists by hand: the token needs Issues: Read and write on both repositories. |
| The ready run fails | The release is not ready, so nothing was pushed. Look at the run that the summary links. Releases that did succeed stay ready, and a rerun skips them (`Ready already, skipped`), so the freeze can be run again. |

Pushing the bumped embargoed branches runs the release workflow for the new versions. It finds no milestone, creates it with no due date, and ends with the notice **Milestone created**.
