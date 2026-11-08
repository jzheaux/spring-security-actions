# After a release is public

When a release has been made public, days after it was built, three things are left to do: copy its issues to the OSS repository, merge its tag (which has the fixes that were embargoed until now) into its branch and forward, and delete the branches that were built for the testing and the staging. The reusable workflow [`post-publish.yml`](../.github/workflows/post-publish.yml) does all of it, for every project, when the tag of the release is pushed, or by hand with the tag as an input. It is a **dry run by default** when it is run by hand, and real on a tag event.

The tag is the release version: `7.1.3`, and not `v7.1.3`. The work is always done in the **commercial** repository of the project, which is the OSS one with `-commercial`, whichever of the two the tag was pushed to.

## Setup checklist

1. **The caller**, a workflow in the repository that the tag is pushed to: the OSS repository, the commercial one, or both. See [the callers](#the-callers).
2. **The secret** `RELEASE_AUTOMATION_TOKEN`, in each repository that has a caller, with the permissions of [the token](#the-token).
3. **The milestones.** The milestone titled with the tag, in the repository that has the issues (see [the kinds](#the-kinds-of-release)). Milestones are never created or changed.
4. **For a release of the OSS repository**, the tag in the OSS repository, and `embargoed/frozen/<branch>` and `embargoed/active/<branch>` in the commercial one, for every branch that the tag is merged through.

## What it does

| # | Step | A real run | A dry run |
|---|---|---|---|
| 1 | **Plan** (`plan-post-publish`). Nothing is changed. | decides, and fails with everything that stops it | same |
| 2 | **Back up** (`backup-branches`), and attach the backup to the run. | a clone with the branches to delete | same |
| 3 | **Copy** the issues (`copy-milestone-issues`), for an OSS release whose milestone is in both repositories. | copies | lists |
| 4 | **Merge** (`merge-tag`), not for a hotfix. | merges in a clone of the runner | same |
| 5 | **Export** the merged branches (`export-merges`), and attach them to the run. | not done | a clone with the merged branches, to look at |
| 6 | **Check, and push** (`push-merges`). | the check, then OSS, then the commercial repository | the check only (`git push --atomic --dry-run`) |
| 7 | **Delete** the branches (`delete-branches`). | one atomic push | lists |

A step that fails stops the run, so a branch is never deleted while a copy or a merge failed. A copy that is skipped (see below) does not stop it. Every step can be run again: the copy skips what has the comment with the link to its copy, a branch that has the tag is not merged again, and a branch that is gone is not deleted twice.

### The kinds of release

The plan works out the kind from the milestone titled with the tag:

| Kind | How it is found | Copy | Merge | Snapshot branch deleted |
|---|---|---|---|---|
| **OSS release** (`7.1.3`, `7.2.0-RC1`) | the OSS repository has the milestone | yes, if the commercial repository has it too | the tag of the OSS repository, into the OSS branches, and then the frozen and active ones | `embargoed/7.1.3-INTERNAL-SNAPSHOT` (a milestone or a release candidate has no `-M1` or `-RC1` in it) |
| **Hotfix** (`7.0.9.1`) | four numbers, and no OSS milestone | no (information) | none: a hotfix never comes back into its generation | `embargoed/7.0.9.1-SNAPSHOT` |
| **Long-term support** (`5.8.30`) | neither | no (information) | the tag of the commercial repository, through `embargoed/lts/*` only | `embargoed/5.8.30-SNAPSHOT` |

`release/<version>` is deleted in every case. Only an OSS release has an internal snapshot. The copy is skipped with a **warning** if the OSS repository has the milestone and the commercial one has none, or if neither has it, and with information for a hotfix or a long-term support release, whose milestone is only in the commercial repository.

### The merges

An OSS release: the tag into the first branch (`Merge tag '7.1.3' into 7.1.x`), then each OSS branch into the next (`Merge branch '7.1.x' into main`), and then, for each generation, its frozen branch merges the frozen one before it and the OSS branch (`Merge branch '7.1.x' into 7.1.x`), and its active branch the active one before it and its frozen branch. A long-term support release goes through the `embargoed/lts/<generation>` branches only. The branches come from the generations of the Spring projects API (`spring-versions`): the one that is named after the generation of the tag, and else the one whose `gradle.properties` has the version of the tag (`main` at `7.2.0-SNAPSHOT` for `7.2.0`). None, or more than one, fails before anything is changed. [merge-tag](../merge-tag/README.md) has the rules for `gradle.properties` and for the version catalog: the branch keeps its own versions.

### Nothing commercial reaches OSS

This is required, and it is checked in code, not left to the order of the steps. [push-merges](../push-merges/README.md) looks at every commit that the OSS push would send: it must be a merge that was made for the tag, with parents that OSS has already, and no `embargoed` in its message. The commits of the tag are not new, as the tag came from OSS. A hotfix or a long-term support release never pushes to OSS, and for them the OSS repository is never read.

### The back-up

Once a branch is deleted its commits are gone from the remote, so the shas are not enough to bring it back. The back-up is a clone with only the branches to delete, attached to the run as the artifact `restore-deleted-branches-7.1.3` (in the **Artifacts** of the run, not in the repository), with the commands in the summary:

```
git push git@github.com:spring-projects/spring-security-commercial.git fc6c49669dfe4c8aa137d56855f01d9f1d1b3375:refs/heads/release/7.1.3
```

Download it, unzip it, and run the commands from inside. It has no credentials. It is kept for the default retention of artifacts, and whoever can read the commercial repository can download it. A dry run attaches it too.

### The merged branches of a dry run

A dry run merges in a clone of the runner, which is gone when the run ends, so it attaches the result too: the artifact `merged-branches-7.1.3`, a repository with only the merged branches, each named as in its repository (`7.1.x`, `embargoed/active/main`), and a `README.md` with the commits and the commit before each merge. The summary has the same table:

```
git log --graph --oneline main
git diff 8e7d6c5 main
```

It is **for looking only**: it has no remote and no command that pushes, as in a dry run before the tag exists its OSS branches have commercial commits. It is attached before the check, so it is there when the check fails. Whoever can read the commercial repository can download it.

### A dry run before the tag exists

The tag is pushed when the release is made public, and a dry run is most useful before that. The input `ref`, a branch or a commit of the **commercial** repository (`release/7.1.3`), stands in for the tag:

- The tag stays the name of the release: the kind, the milestones, the snapshot branch, the branches to delete, the artifacts and the messages of the merges (`Merge tag '7.1.3' into 7.1.x`) are the ones of the tag. The version is never worked out from a real tag.
- The plan records the commit of the ref, and that commit is merged, from the commercial repository for an OSS release and for a long-term support one.
- **Only a dry run may use it, and only while the tag does not exist.** A real run, or a tag that is pushed, always uses the tag, so a branch is never merged forward by mistake. A dry run fails if the tag exists too, unless the ref is the tag itself (`7.1.3`), which is a dry run with the tag.
- **The check of OSS is simulated.** Until the tag is public, the commits of the ref only exist in the commercial repository, so the check that nothing commercial reaches OSS would always stop. It treats the commits of the ref as public, and the summary says so: "Simulated: the tag does not exist yet". Any other commit that only the commercial repository has is still rejected.

## The callers

A tag event is real, and a run by hand is a dry run unless it is unticked. A tag that is pushed runs the file of the commit that it points to, so the caller must be in the history of the tagged commit.

```yaml
name: "Post Publish"
run-name: "${{ inputs.tag || github.ref_name }}: Post Publish${{ github.event_name == 'workflow_dispatch' && inputs.dry-run && ' (dry run)' || '' }}"
"on":
  push:
    tags:
      - "[0-9]*.[0-9]*.[0-9]*"
  workflow_dispatch:
    inputs:
      tag:
        description: "The tag, which is the version of the release, for example 7.1.3"
        required: true
        type: string
      ref:
        description: "Dry run only, before the tag exists: a branch or a commit of the commercial repository that stands in for the tag, for example release/7.1.3"
        required: false
        type: string
      dry-run:
        description: "Only say what would be done: nothing is copied, pushed or deleted"
        default: true
        type: boolean
permissions:
  contents: read
jobs:
  post-publish:
    uses: spring-io/spring-security-actions/.github/workflows/post-publish.yml@<the commit of a tag>
    with:
      tag: ${{ inputs.tag || github.ref_name }}
      ref: ${{ github.event_name == 'workflow_dispatch' && inputs.ref || '' }}
      dry-run: ${{ github.event_name == 'workflow_dispatch' && inputs.dry-run }}
      runs-on: ${{ vars.UBUNTU_RUNS_ON }}
    secrets:
      RELEASE_AUTOMATION_TOKEN: ${{ secrets.RELEASE_AUTOMATION_TOKEN }}
```

The same file works in the OSS repository and in the commercial one: the workflow names the commercial repository from the one that calls it. A workflow that is run by hand is only listed in the Actions tab if its file is on the default branch, so the caller must be there. A tag that is not a version fails the run at the start, and nothing is changed.

## The token

`RELEASE_AUTOMATION_TOKEN` is the one of the other workflows, and needs, on **both** repositories:

| What for | Fine-grained token | Classic token |
|---|---|---|
| fetch and push the branches, delete the branches | **Contents: Read and write** | `repo` |
| read the milestones, copy the issues and comment on the originals, create labels | **Issues: Read and write** | `repo` |

Both repositories must let the token push to their protected branches (a bypass in the ruleset), as the merges are pushed directly, and the branches are deleted.

## Reading a run

The summary has the plan, the back-up, the copy, the merges with what each changed in the version catalog, the merged branches (a dry run), the pushes, and the branches.

| What the run says | What to do |
|---|---|
| `... is not a tag of a version` | The tag is the release version, `7.1.3`, and not `v7.1.3`. |
| **Tag not found** | The tag is in the OSS repository for an OSS release, and in the commercial one for a long-term support release. Push it, or do a dry run with the input `ref` (`release/7.1.3`). |
| **Ref not found** | The commercial repository has no branch or commit of that name. |
| **Ref only for a dry run** | `ref` stands in for a tag that does not exist yet, so a real run cannot have it. Untick the ref, or tick the dry run. Nothing was changed. |
| **Tag exists** | A dry run has a `ref`, and the tag exists. Leave `ref` empty, or give the tag itself as the ref. |
| **No branch for the tag** | No generation of the Spring projects API has the tag, and no candidate has a version of it in `gradle.properties`. Look at the generations, or merge by hand. |
| **Branches missing** | A frozen, active or long-term support branch of the chain does not exist. Create it, or merge by hand. |
| **No commercial milestone**, **No milestone** (warnings) | The issues were not copied. Create the milestone and run it again if they should be. |
| **Merge conflict** | A file that is not a version file conflicts. Merge by hand, then run it again. Nothing was pushed. |
| **Commercial code would reach OSS** | Do not push. The message lists the commits. Nothing was pushed or deleted. |
| `Pushing the OSS branches was refused` | Someone pushed to an OSS branch since the plan, or a protection refused it. Nothing was pushed. Run it again. |
| `The OSS branches were pushed, and the commercial branches were refused` | The message has the command to push the commercial branches by hand. Run it again once that is settled: a branch that has the tag is not merged again. |
| `Nothing was deleted: ... is the default branch` | A branch to delete is the default branch of the repository. Nothing is deleted. |

A line of the version catalog that both sides changed, next to a line that only one changed, is one conflict for git, and one side wins both. The summary of the merges shows what changed in the versions, so look at it.
