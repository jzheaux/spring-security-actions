# push-freeze

Checks that **no commercial code goes to OSS**, and pushes the branches of a code freeze: atomically, without force, the commercial repository first.

## The tripwire

It does not trust how the branches were made. For every OSS branch it looks at what a push would send, the commits that the OSS remote lacks, and fails, with every reason, unless each one

- was made by the freeze (`apply-freeze` lists them),
- is not in the commercial repository (a commit that its branches have and OSS lacks),
- has no `embargoed` in its message,
- is a version commit that changes `gradle.properties` and nothing else, or a merge whose two parents are in OSS already or were made by the freeze.

It fails with the title **Commercial code would reach OSS**, before anything is pushed or marked ready. The pushes name each branch with an explicit refspec (`refs/freeze/oss/7.0.x:refs/heads/7.0.x`): never `--all`, `--mirror`, tags or a force.

## The modes

- `check`: the tripwire, and `git push --atomic --dry-run` to both remotes, which says that a branch is not a fast forward (someone pushed in the meantime) while nothing has happened.
- `push`: the tripwire again, then the commercial repository, then OSS, each in one atomic push: if one branch is refused, none of that push is made. The commercial one is first, so nothing public changes until it worked. If OSS is refused after it, the error says so, and which commits are left to push by hand.

## Inputs

| Input | Default | Description |
|---|---|---|
| `mode` | required | `check` or `push`. |
| `apply-file` | `code-freeze/apply.json` in `RUNNER_TEMP` | What was done, from `apply-freeze`. |
| `push-file` | `code-freeze/push.json` in `RUNNER_TEMP` | Where to write what was checked and pushed. |
| `commercial-remote`, `oss-remote` | `origin`, `oss` | The remotes. |
| `path` | `.` | The clone. |

## Secrets and permissions

It pushes with the credentials that `actions/checkout` stored, for the same host, so the token of the checkout (`RELEASE_AUTOMATION_TOKEN`) needs **Contents: Read and write** on both repositories, and to be allowed to push to their protected branches.

## Trying it

`npm ci`, then `npm test`: the tests make bare repositories in a temporary directory, and try to leak commercial commits into OSS in several ways.
