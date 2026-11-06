# push-merges

Checks that **no commercial code goes to OSS**, and pushes the branches that `merge-tag` merged the tag of a public release into: atomically, without force, **OSS first**.

## The tripwire

It does not trust how the branches were made. For every OSS branch it looks at what a push would send, the commits that OSS lacks, and fails, with every reason, unless each one

- was made by `merge-tag` (it lists them),
- is not in the commercial repository (a commit that its branches have and OSS lacks),
- has no `embargoed` in its message,
- is a merge whose two parents are in OSS already or were made by `merge-tag`.

The commits of the tag are not new: the tag came from OSS, so what it has is public (it has the fixes that were embargoed until the release). It fails with the title **Commercial code would reach OSS**, before anything is pushed. The pushes name each branch with an explicit refspec (`refs/post-publish/oss/7.1.x:refs/heads/7.1.x`): never `--all`, `--mirror`, tags or a force. The merges of a long-term support release or of a hotfix never have an OSS branch: if one has, it fails.

## The modes

- `check`: the tripwire, and `git push --atomic --dry-run` to both remotes, which says that a branch is not a fast forward (someone pushed in the meantime) while nothing has happened.
- `push`: the tripwire again, then OSS, then the commercial repository, each in one atomic push: if one branch is refused, none of that push is made. OSS is first, as what it gets is the tag and merges of it, which are public. If the commercial repository is refused after OSS, the error says so, and which commits are left to push by hand. Run it again once that is settled: a branch that already has the tag is not merged again.

A branch that did not change (it had the tag already) is not pushed, so a run can be repeated.

## Inputs

| Input | Default | Description |
|---|---|---|
| `mode` | required | `check` or `push`. |
| `merge-file` | `post-publish/merge.json` in `RUNNER_TEMP` | What `merge-tag` did. |
| `push-file` | `post-publish/push.json` in `RUNNER_TEMP` | Where to write what was checked and pushed. |
| `commercial-remote`, `oss-remote` | `origin`, `oss` | The remotes. |
| `summary` | `true` | `false` leaves the table out of the summary. |
| `path` | `.` | The clone. |
| `token` | | A token that can push to both repositories. |

## Outputs

`push-file`: the branches of each repository with their commits, whether they were pushed, and what the tripwire found.

## Secrets and permissions

The token (`RELEASE_AUTOMATION_TOKEN`) needs **Contents: Read and write** on both repositories, and to be allowed to push to their protected branches. It is the credentials of the pushes only (an `http.extraheader` given through the environment): it is stored nowhere.

## Trying it

`npm ci`, then `npm test`: the tests make bare repositories in a temporary directory, and try to leak commercial commits into OSS in several ways.
