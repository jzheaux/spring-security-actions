# spring-security-actions

GitHub Actions of the Spring Security projects. Every action is in a directory of its own, with its own `README.md` that documents its inputs, outputs and secrets.

Use one with `uses: spring-io/spring-security-actions/<action>@<ref>`.

## The actions of the release automation

They are written in JavaScript (Node 24), and every one of them is **self contained**: it has its own `package.json` and lock file, its own sources in `src/`, its own tests in `test/` (with the fake of GitHub and the fixtures that they need), and its own `dist/`, the bundle that GitHub runs. Nothing is shared between them, so one can be changed, updated and used without the others. Each one can be run locally too: see its README.

| Action | What it does |
|---|---|
| [`align-milestone`](align-milestone/README.md) | Sets the due date of the milestone of a hotfix to the commercial general availability of its release train. |
| [`apply-commercial-license`](apply-commercial-license/README.md) | Changes a repository to the commercial license, for a hotfix: the headers (one year), `etc/checkstyle/header.txt`, `LICENSE.txt` and the license of the POM. |
| [`apply-freeze`](apply-freeze/README.md) | Makes the merges and the version commits of a code freeze, locally, in the order that keeps commercial code out of OSS. |
| [`backup-branches`](backup-branches/README.md) | Backs up branches that are going to be deleted, in a clone with only those branches, with the commands to restore them. |
| [`check-not-ready`](check-not-ready/README.md) | Fails if the release train has the release as ready already. |
| [`check-oss-support`](check-oss-support/README.md) | Fails if the OSS support of the generation of a version ends before a date, from the Spring projects API. |
| [`compare-branches`](compare-branches/README.md) | Whether a branch has changes that another branch lacks: a hotfix is only built for an active embargoed branch that differs from the frozen one. |
| [`close-milestones`](close-milestones/README.md) | Closes the milestone of each release of a code freeze, and deletes the milestone of a hotfix that has no issues. |
| [`compute-release-version`](compute-release-version/README.md) | The release version of a snapshot version, and its due date, from the milestones of a repository. |
| [`compute-tag-versions`](compute-tag-versions/README.md) | The release version and the snapshot version of a tag. |
| [`copy-milestone-issues`](copy-milestone-issues/README.md) | Copies the issues and the pull requests of a milestone to another repository, as issues, and comments on each original with the link to its copy. |
| [`delete-branches`](delete-branches/README.md) | Deletes branches of a repository, all at once or none (`git push --atomic --delete`). |
| [`ensure-cve-issues`](ensure-cve-issues/README.md) | A closed issue for every CVE fix of a push, in the milestone of its release. It makes the ones that are missing. |
| [`ensure-dependency-issues`](ensure-dependency-issues/README.md) | An issue for every dependency update, in a milestone. It makes the ones that are missing. |
| [`ensure-milestone`](ensure-milestone/README.md) | Creates a milestone in a repository if it has none of that title, with no due date. |
| [`freeze-summary`](freeze-summary/README.md) | Writes the summary of a code freeze. |
| [`git-identity`](git-identity/README.md) | Sets who commits: `github-actions[bot]` by default. |
| [`join-train`](join-train/README.md) | Joins a release to the release train, by running the workflow Release Train - Join of the project on the release branch. |
| [`list-branches`](list-branches/README.md) | The OSS and the commercial (long-term support) branches of a Spring project, from the Spring projects API, and the check of an override. |
| [`load-train`](load-train/README.md) | Reads the release train of a date. |
| [`map-train-versions`](map-train-versions/README.md) | Which versions of a version catalog the release train asks to change, and to what. |
| [`merge-release`](merge-release/README.md) | Merges the release into the branch of its hotfix. |
| [`merge-tag`](merge-tag/README.md) | Merges the tag of a release that was made public into its branch and forward through the newer branches, locally, keeping the versions of every branch. |
| [`name-repositories`](name-repositories/README.md) | The project and its OSS repository, from the commercial repository. |
| [`plan-freeze`](plan-freeze/README.md) | Plans a code freeze: the next versions, the releases to mark ready, and everything that stops it. |
| [`plan-post-publish`](plan-post-publish/README.md) | Plans what happens after a release is made public: its kind, whether its issues are copied, the merges of its tag and the branches to delete. |
| [`plan-release-branches`](plan-release-branches/README.md) | What the push of an embargoed branch builds. |
| [`push-branches`](push-branches/README.md) | Pushes branches at once or none, and summarizes them. |
| [`push-freeze`](push-freeze/README.md) | Checks that no commercial code goes to OSS, and pushes the branches of a code freeze, atomically and without force. |
| [`push-merges`](push-merges/README.md) | Checks that no commercial code goes to OSS, and pushes the branches that a tag was merged into, OSS first, atomically and without force. |
| [`ready-train`](ready-train/README.md) | Runs the workflow Release Train - Ready of the project on each release branch of a code freeze, and waits for it. |
| [`set-version`](set-version/README.md) | Sets the version of `gradle.properties`, in a commit of its own. |
| [`start-branch`](start-branch/README.md) | Starts (or resets) a branch at a commit or a branch. |
| [`update-versions`](update-versions/README.md) | Changes the versions of a version catalog, with one commit for each. |

## The workflows of the release automation

[`release-branches.yml`](.github/workflows/release-branches.yml) is a reusable workflow that builds `release/<version>` and the snapshot branches on a push to an embargoed branch, with the actions above and nothing else (every step is an action). [docs/release-branches.md](docs/release-branches.md) is the guide: what it builds, how to call it, the secret and the tokens it needs, and what to do when it fails.

[`post-publish.yml`](.github/workflows/post-publish.yml) is a reusable workflow for what follows once a release is public: it copies the issues of its milestone to OSS, merges its tag forward, and deletes the branches that were built for the release. It is run when the tag is pushed, or by hand, with a dry run. [docs/post-publish.md](docs/post-publish.md) is the guide: the callers, the token, and what to do when it fails.

[`ensure-cve-issues.yml`](.github/workflows/ensure-cve-issues.yml) is a reusable workflow for a push to an active branch: it makes a closed issue for every `Fixes CVE-ID` that the push has, in the milestone of the release. [docs/cve-issues.md](docs/cve-issues.md) is the guide, with the caller.

[`code-freeze.yml`](.github/workflows/code-freeze.yml) is a reusable workflow for the code freeze of a project: it moves every branch to its next development version, merges forward, marks the releases ready and pushes, with a dry run that is on by default. [docs/code-freeze.md](docs/code-freeze.md) is the guide, with the caller, the stub that the default branch of the commercial repository needs, and the guarantee that nothing commercial reaches OSS.

## Working on an action

```shell
cd <action>
npm ci
npm test            # no network and no token
npm run build       # formats, and bundles src/ into dist/: commit both
```

`dist/` is committed, because GitHub runs it with no `npm install`, and CI fails if it is not the build of `src/`. Dependabot updates the dependencies of every action, and the actions that these use.

## Releasing a change of an action

The release workflow calls the actions of this repository at a commit, so a change of an action reaches the callers in three steps: merge the change, change the commit in every `uses:` of `.github/workflows/release-branches.yml` and `.github/workflows/code-freeze.yml` to the commit of the merge (CI checks that they are commits of this repository), and tag the commit of that second change. Callers of the workflow then pin the tag's commit.
