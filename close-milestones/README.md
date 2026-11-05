# close-milestones

Closes the milestone of each release of a code freeze (`7.0.5`, `7.1.0-RC1`, `6.5.11`), once the freeze has pushed its branches, and deletes the milestone of a **hotfix that has no issues**. The releases and their milestones are in the plan that `plan-freeze` wrote: the OSS repository has the milestones of the OSS and frozen releases, and the commercial repository has those of a hotfix and of long-term support.

## What it does

Each milestone is **read again** first, as issues may have been moved since the plan, and what it reads decides:

| The milestone | What is done | Result |
|---|---|---|
| a hotfix with no issues at all, open or closed (it may be closed already) | deleted | `deleted` |
| closed already | left alone | `already-closed` |
| open, no open issues | closed | `closed` |
| open, with open issues | closed all the same, the summary says how many | `closed-with-open` |
| any of the above, and GitHub refused | the others go on | `failed` |

Only the milestone of a hotfix is ever deleted, and a deletion cannot be undone. If any milestone failed, the action fails at the end and names each one: the freeze is done by then, so the milestone is closed by hand.

A dry run does not run this action: the summary says what it would do from the plan.

## Inputs

| Input | Default | Description |
|---|---|---|
| `plan-file` | `code-freeze/plan.json` in `RUNNER_TEMP` | The plan, which has the milestone of each release. |
| `milestones-file` | `code-freeze/milestones.json` in `RUNNER_TEMP` | Where to write the result of each milestone. |
| `token` | required | A token that writes the milestones of both repositories. |

## Outputs

`milestones-file`: for each milestone, `version`, `repository`, `number`, `url`, the `open` and `closed` issues that it was read with, and `result` (`error` if it failed).

## Secrets and permissions

The token needs **Issues: Read and write** on the OSS and on the commercial repository (fine-grained), or `repo` (classic).

## Trying it

`npm ci`, then `npm test`: no network and no token.
