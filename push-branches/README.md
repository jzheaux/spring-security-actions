# push-branches

Pushes the branches that the workflow built, all at once or none, so that a failure never leaves one of them built and not the others. the release workflow pushes the release branch and the snapshot branch with it, as its last step.

## What it does

- It is forced, because the branches are built again from the pushed commit every time.
- It needs the token of the checkout to be the one that triggers workflows (`RELEASE_AUTOMATION_TOKEN`): the pushes of `GITHUB_TOKEN` do not run the workflows of the new branches.
- The summary of the step says what the push creates, and for each branch how it was created and what it has that OSS lacks (see below). Each branch links to its page on GitHub, built from `GITHUB_SERVER_URL` (`https://github.com` if it is not set) and `GITHUB_REPOSITORY`; without `GITHUB_REPOSITORY` there are no links.

## The summary

It begins with what the push creates: the two branches that are used for releasing, the snapshot and the release (`This push creates two branches that are used for releasing 7.0.9: ...`), the release train if there was one, and a table of the branches, their versions, and how many commits each has that OSS lacks. Then, for the snapshot first and the release second (the order that they are built in), a section with:

- **How it was created**: the steps that the run did, one sentence each, in order, read from the commits that were made on the branch after the pushed commit (`base`): the merge of the branch that a hotfix is based on (or why there was none), the commercial license, the version, and the dependency updates with their issues. The commits are named by the subjects that the actions of this repository give them (`src/steps.js`, and a test that the actions still make them), so a commit with another subject is shown as it is.
- **Commits not in OSS** (or in the previous release, or in the release that a hotfix fixes, by kind): the commits of the branch that what it is compared with lacks, each with its sha linked to its commit and its subject, the oldest first. The merge commits are left out, and so are the commits that a merge made with `git merge -s ours` (a merge whose tree is the one of its first parent) merged in: nothing of those is in the branch, so each heading says `(omits commits merged with -s ours)`. When there is such a merge, the command under the list has the loop that finds it (`for m in $(git rev-list --merges A..B); do git diff --quiet $m^1 $m && echo "^$m^2"; done | xargs git log --oneline --no-merges --reverse A..B`); without one it is a plain `git log`. A list stops at 50 (`and 3 more`, linked to the compare view). It is followed by the `git log` command that prints the same list in a clone, with no limit. What it is compared with:
  - a **hotfix** (`kind` `active`, heading **Commits not in `7.0.9`**, the release it fixes) is compared with the OSS version that it is based on (`oss-tag`: the tag `7.0.9` for `7.0.9.1`). While that release is not public there is no such tag, and it is compared with the branch that it is based on (`release-of` for the release, `snapshot-of` for the snapshot), which the heading says;
  - a **frozen** branch is compared with the branch of OSS of its generation (`oss-branch`, `7.0.x`);
  - a **long-term support** branch (`lts`, heading **Commits not in the previous release**) is compared with the release before it (`5.8.29` for `5.8.30`, the one that **All changes in this release** uses), because it is commercial and OSS has no release of it. With no release before it, with the pushed commit;
  - if that is not possible for a frozen branch (OSS has no such branch, or cannot be read: a warning says so, and the run goes on), or if `oss-repository` is not given, with the pushed commit: the commits that the run made.
- **All changes in this release**, for the release branch: how many commits it has since the release before it (without the merge commits, and with them), a link to the compare view, and the `git log --no-merges` command that lists them. The release before it is the greatest version below it, from the tags of OSS (`7.0.8` for `7.0.9`, and `7.0.9` for `7.0.9.1`) and the `release/*` branches of the repository: the tag if there is one. There is no such section if there is none.

Under the table, the commands that get a clone ready for the ones of the summary: OSS as a remote (`git remote add oss ...`, `git fetch oss 7.0.x --tags`), if a command uses it, and the commercial repository as the remote `commercial` (`git remote add commercial ...`, `git fetch commercial`) for the branches that were pushed. The commands always say `oss/...` and `commercial/...`, whatever the clone calls its remotes.

OSS is fetched read-only from the public repository, and its tags into `refs/oss-tags/*`, so no tag of the repository that is checked out is replaced. The checkout needs the history of the branches (`fetch-depth: 0`).

## Inputs

| Input | Default | Description |
|---|---|---|
| `branches` | required | The branches, as `branch=version`, one per line. The version is for the summary. |
| `base` | `GITHUB_SHA` | The commit that was pushed. The branches were started at it, so what comes after it is what the run made on them. |
| `remote` | `origin` | The remote to push to. |
| `title` | `GITHUB_REF_NAME` | The title of the summary. |
| `milestone-url` | | The URL of the milestone of the release. The version of a branch links to it in the summary, unless it ends in `-SNAPSHOT`. |
| `train` | | The release train that was used, `2026.11.19`. The summary has the line `Release train 2026.11.19` under its title. |
| `train-url` | | The URL of the branch of that train: the line of the summary links to it. |
| `train-status` | | Where the release is in the train, `not-joined`, `joined` or `ready` (the output `status` of `check-not-ready`). The line of the train says so: `Release train 2026.11.19: joined, not ready yet`. |
| `train-state` | | The state of the train itself (`pending`, `promoted`, ...), the output `train-state` of `check-not-ready`. The line says `Release train 2026.11.19 is pending`. |
| `train-state-url` | | The URL of the line of `train.yml` with the state: the state links to it. |
| `kind` | | `frozen`, `active` or `lts` (the output `kind` of `plan-release-branches`). For `active`, a hotfix, the summary says how the merges of the branches that it is based on went. |
| `oss-repository` | | The OSS repository, `spring-projects/spring-security`, read from the server of the workflow. Without it the commits that OSS lacks are not looked for: the summary lists the commits that the run made on the pushed commit. |
| `oss-url` | | The address that git fetches OSS from, if it is not the repository on the server. For a test. |
| `oss-branch` | | The branch of OSS of the generation, `7.0.x` (the output `oss-branch` of `plan-release-branches`). A frozen or long-term support branch is compared with it. |
| `oss-tag` | | For a hotfix, the tag that OSS has once the release it fixes is public, `7.0.9` (the output `oss-tag`). |
| `snapshot-of` | | For a hotfix, the branch that its snapshot is based on, `embargoed/7.0.9-INTERNAL-SNAPSHOT` (the output `hotfix-of-snapshot`). |
| `release-of` | | For a hotfix, the branch that its release is based on, `release/7.0.9` (the output `hotfix-of-release`). |
| `merged-snapshot` | | The output `merged` of `merge-release` for the snapshot branch of a hotfix: `true`, `false` (the branch it is based on did not exist) or `up-to-date`. The summary says so. |
| `merged-release` | | The same, for the release branch of a hotfix. |
| `path` | `.` | The directory of the git repository. |

## Secrets and permissions

It needs no secret of its own. It pushes with the credentials that `actions/checkout` stored, so the checkout must use the token that can push and trigger workflows (`RELEASE_AUTOMATION_TOKEN`, see `.github/RELEASE_AUTOMATION.adoc`), with the permission `contents: write` on the repository.

## Using it

```yaml
- uses: spring-io/spring-security-actions/push-branches@v1
  with:
    branches: |
      release/7.0.1=7.0.1
      embargoed/7.0.1-INTERNAL-SNAPSHOT=7.0.1-INTERNAL-SNAPSHOT
```

## Running it locally

An ordinary Node program (Node 24). `npm ci` once in this directory, then run it with its inputs as `INPUT_<NAME>` variables:

```shell
cd push-branches
npm ci
# in a clone with a remote, on a branch that you can push
env 'INPUT_BRANCHES=try/branch=1.0.0' 'INPUT_BASE=HEAD' node src/index.js
```

`npm test` runs its tests, with no network and no token.
