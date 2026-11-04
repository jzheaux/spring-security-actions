# plan-release-branches

Decides what the push of an embargoed branch builds. It is the first thing that the release workflow does, and it only reads its two inputs: nothing is checked out or changed.

A long-term support embargoed branch, `embargoed/lts/7.0.x` (`7.0.1-SNAPSHOT`), is commercial: it is merged into other long-term support branches only, and releases its own version, so `release/7.0.1` is built from the pushed commit, and a snapshot branch of its own version, `embargoed/7.0.1-SNAPSHOT`, as a hotfix has (a plain `-SNAPSHOT`, and never an internal one: only OSS has that, as it publishes a regular snapshot without the fixes for vulnerabilities, and a commercial snapshot has them). Its `kind` is `lts`, `deployment-destination` is `Spring Enterprise`, `snapshot-branch` is `embargoed/7.0.1-SNAPSHOT` and `snapshot-version` is `7.0.1-SNAPSHOT`, and `hotfix`, `hotfix-of-snapshot`, `hotfix-of-release`, `oss-tag` and `frozen-branch` are empty (`hotfix` is `false`).

## What it decides

|  | A frozen embargoed branch, `embargoed/frozen/7.0.x` (`7.0.1-SNAPSHOT`) | An active embargoed branch, `embargoed/active/7.0.x` (`7.0.1-SNAPSHOT`) |
|---|---|---|
| `kind` | `frozen` | `active` |
| `base-version`, which the release version is worked out from | `7.0.1-SNAPSHOT` | `7.0.1.1-SNAPSHOT`, the hotfix |
| `hotfix` | `false` | `true` |
| `hotfix-of-snapshot`, the snapshot that the hotfix snapshot is based on | empty | `embargoed/7.0.1-INTERNAL-SNAPSHOT` |
| `hotfix-of-release`, the release that the hotfix release is based on | empty | `release/7.0.1` |
| `hotfix-of-version`, the version of that release | empty | `7.0.1` |
| `oss-branch`, the branch of the OSS repository of the generation | `7.0.x` | `7.0.x` |
| `oss-tag`, the tag that OSS has once the release is public | empty | `7.0.1` |
| `deployment-destination`, where the release is deployed to | `Maven Central` | `Spring Enterprise` |
| `frozen-branch`, the frozen embargoed branch of the same generation | empty | `embargoed/frozen/7.0.x` |
| `snapshot-branch` | `embargoed/7.0.1-INTERNAL-SNAPSHOT` | `embargoed/7.0.1.1-SNAPSHOT` |
| `snapshot-version` | `7.0.1-INTERNAL-SNAPSHOT` | `7.0.1.1-SNAPSHOT` |

- The two bases of a hotfix are its own kind of branch of the release that it fixes: the hotfix snapshot is based on the snapshot (`embargoed/7.0.1-INTERNAL-SNAPSHOT`), and the hotfix release on the release (`release/7.0.1`). `oss-branch` and `oss-tag` are what the summary compares the branches with: the commits that OSS lacks.
- A snapshot never carries a milestone or a release candidate: the snapshot of `7.1.0-SNAPSHOT` is `7.1.0-INTERNAL-SNAPSHOT`, and not the version of the release that is built (`7.1.0-RC1`).
- A hotfix and a long-term support version never have an internal snapshot, and a frozen embargoed branch has no hotfix.
- A version that ends with `.0` on an active embargoed branch has a hotfix too (`7.2.0.1`), but only once its next release is the GA (`7.2.0`) and not a milestone or a release candidate (`7.2.0-RC1`), which have none. This action plans it, and the release workflow ends the run, with a notice, if the milestone is not the GA.

## Inputs

| Input | Required | Description |
|---|---|---|
| `ref-name` | yes | The branch that was pushed: `embargoed/frozen/<generation>` or `embargoed/active/<generation>`. |
| `version` | yes | The version of `gradle.properties` on it, `<major>.<minor>.<patch>-SNAPSHOT`. |

## Outputs

`release`, `kind`, `base-version`, `hotfix`, `hotfix-of-snapshot`, `hotfix-of-release`, `hotfix-of-version`, `oss-branch`, `oss-tag`, `deployment-destination`, `frozen-branch`, `snapshot-branch`, `snapshot-version`: see the table above. `frozen-branch` is what the release workflow compares an active embargoed branch with, with `compare-branches`, before it builds the hotfix. When `release` is `false`, only `release` and `kind` are written.

## Fails when

- the branch is not an embargoed branch
- the version is not `<major>.<minor>.<patch>-SNAPSHOT` (`7.0.1`, `7.1.0-M1-SNAPSHOT`)
- a frozen embargoed branch has a hotfix version (`7.0.1.1-SNAPSHOT`): only an active embargoed branch has a hotfix
- an active embargoed branch has a hotfix version already: it has the version of the release that it fixes

## Secrets and permissions

None. It reads two inputs.

## Using it

```yaml
- id: version
  uses: spring-io/spring-release-actions/compute-version@...
- id: plan
  uses: spring-io/spring-security-actions/plan-release-branches@v1
  with:
    ref-name: ${{ github.ref_name }}
    version: ${{ steps.version.outputs.version }}
- if: steps.plan.outputs.release == 'true'
  run: echo "Building ${{ steps.plan.outputs.snapshot-branch }}"
```

## Running it locally

```shell
cd plan-release-branches
npm ci
export GITHUB_OUTPUT=$(mktemp)
env 'INPUT_REF-NAME=embargoed/active/7.0.x' 'INPUT_VERSION=7.0.1-SNAPSHOT' \
    node src/index.js
cat "$GITHUB_OUTPUT"
```

`npm test` runs its tests, which need no network and no token.
