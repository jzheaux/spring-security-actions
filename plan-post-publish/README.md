# plan-post-publish

Plans what happens after a release has been made public, and **changes nothing**. It fails, before anything is changed, with everything that stops it. It reads the milestones, the tag and the branches through the GitHub API, and the generations of the project from the Spring projects API (`spring-versions`), so it needs no checkout.

## What it decides

- **The kind.** `oss` if the OSS repository has the milestone titled with the tag; else `hotfix` if the version has a fourth number (`7.0.9.1`); else `lts`, a commercial long-term support version.
- **Whether the issues are copied.** Only for `oss`, and only if the commercial repository has the milestone too: the milestones are never created. The other cases are skipped and logged: an OSS milestone with no commercial one is a warning, a tag that no repository has a milestone for is a warning, and a commercial only one (a hotfix or a long-term support version) is information.
- **The branches to delete**: `release/<version>` and the snapshot branch `embargoed/<snapshot version>`. The snapshot version is the version without its `-M<n>` or `-RC<n>` and with `-INTERNAL-SNAPSHOT` for `oss` (only OSS has an internal snapshot) and `-SNAPSHOT` otherwise.
- **The merges**, none for a hotfix, which never comes back into the branches of its generation. The tag has to exist: in OSS for `oss`, in the commercial repository for `lts`. The candidates are the generations that `spring-versions` shows: the OSS branches (`7.0.x`, `7.1.x`, `main`) for `oss`, and the commercial generations for `lts`, in the order of their initial release (`2021.2.x` of Spring Session comes before `3.4.x`). The branch of a commercial generation is `embargoed/lts/<generation>`, or, if there is none of that name, the one `embargoed/lts/*` branch whose `gradle.properties` has a version of the major and minor of the generation (`embargoed/lts/2.7.x` for `2021.2.x`); more than one fails, and none is listed as a branch that is missing. The OSS branches of these generations are never read. The branch of the tag is the candidate named after its generation (`7.0.x`) and, if there is none, the one whose `gradle.properties` has a `version=` of the major and minor of the tag (`main` at `7.2.0-SNAPSHOT` for `7.2.0`, or `embargoed/lts/2.7.x` at `2021.2.9-SNAPSHOT` for `2021.2.9`). None, or more than one, fails. The chain is that branch and every newer one of its kind. Each OSS branch of the chain needs `embargoed/frozen/<branch>` and `embargoed/active/<branch>` in the commercial repository, and every missing branch is listed.
- **A dry run before the tag exists.** The input `ref`, a branch or a commit of the commercial repository (`release/7.1.3` for `7.1.3`), stands in for the tag, and the plan records the commit that it is. The tag stays the name of the release for everything else (the kind, the milestones, the snapshot branch, the branches to delete). `ref` is only for a dry run, and only while the tag does not exist: a real run with it fails (**Ref only for a dry run**), and so does a dry run when the tag exists (**Tag exists**), unless the ref is the tag itself, which is a plain dry run. A tag that does not exist with no `ref` fails naming both ways out, and a `ref` that does not exist fails (**Ref not found**). A hotfix is not merged, so it does not use the ref.

## Inputs

| Input | Required | What it is |
|---|---|---|
| `release-version`, `base-version`, `generation`, `hotfix` | yes (`hotfix` no) | The outputs of `compute-tag-versions`. |
| `oss-repository` | yes | `owner/repo`, the OSS repository. |
| `commercial-repository` | yes | `owner/repo`, the commercial repository. |
| `project` | yes | The project in the Spring projects API, `spring-security`. |
| `api-url` | no | The API. The default is `https://api.spring.io`. |
| `dry-run` | no | `true` if the run is a dry run, which the summary says. |
| `ref` | no | A branch or a commit of the commercial repository that stands in for the tag, for a dry run before the tag exists. Only with `dry-run: true`. |
| `plan-file` | no | Where the plan is written. The default is `post-publish/plan.json` in `RUNNER_TEMP`. |
| `token` | yes | A token that can read both repositories. |

## Outputs

`plan-file`, `kind`, `copy` (`true` or `false`), `merge` (`oss`, `lts` or `none`), `snapshot-version` and `delete-branches` (one per line). The plan file has the rest: the ref that was used, the milestones, the reason for the copy, and the branches of the merge with their frozen and active branches.

## Secrets and permissions

A token that reads both repositories: contents and issues.

## Trying it

`npm ci`, then `npm test`: the tests need no network. They use a fake of GitHub that can only read, and of the Spring projects API.
