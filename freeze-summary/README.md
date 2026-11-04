# freeze-summary

Writes the summary of a code freeze, from the files that the other actions wrote. Every part is optional, as the run may have stopped before it, so it is run with `if: always()`.

## What it shows

- **Versions:** each branch, its repository, the version it has, the one it is bumped to, and the commit (an embargoed branch gets the version by the merge of the OSS branch, and has no commit of its own).
- **Releases marked ready:** each release branch once, with the branches that it is the release of, and a link to the run of `release-train-ready.yml` and its result. A dry run says `Not run, this is a dry run`, and a release that was ready already says `Ready already, skipped`.
- **Merges** in order, with the version that each one keeps (across: the target's, down: the source's), and the rotation.
- **Push:** what would be or was pushed, and the OSS leak check.
- If the plan found problems, every one of them, with nothing else.

The title has the project and the release train, and `DRY RUN` and `FAILED` when they are.

## Inputs

| Input | Default | Description |
|---|---|---|
| `dry-run` | `false` | `true` for a dry run. |
| `job-status` | | `failure` puts FAILED in the title. |
| `plan-file`, `apply-file`, `ready-file`, `push-file` | in `code-freeze/` in `RUNNER_TEMP` | The files of the other actions. |

## Secrets and permissions

None.

## Trying it

`npm ci`, then `npm test`.
