# compute-tag-versions

Works out what follows from the tag of a version: the version that a snapshot is made from, the generation, and whether it is a hotfix. It knows nothing about repositories: it only changes text.

## What it does

- The tag is the release version as it is: `7.0.1`, and not `v7.0.1`. A tag that is not a version fails.
- The base version is the release version without its milestone (`-M1`) or release candidate (`-RC1`): the snapshot version is the base version and a suffix, which depends on the kind of release, so it is not worked out here.
- The generation is `<major>.<minor>.x`. A hotfix is in the generation of the version that it fixes.
- A hotfix has a fourth number.

| Tag | `base-version` | `generation` | `hotfix` |
|---|---|---|---|
| `7.0.1` | `7.0.1` | `7.0.x` | `false` |
| `7.0.1.1` | `7.0.1.1` | `7.0.x` | `true` |
| `7.1.0-M2` | `7.1.0` | `7.1.x` | `false` |
| `7.1.0-RC1` | `7.1.0` | `7.1.x` | `false` |
| `2021.2.9` | `2021.2.9` | `2021.2.x` | `false` |
| `v7.0.1`, `7.0`, `7.1.0-RC` | fails | | |

## Inputs

| Input | Required | Description |
|---|---|---|
| `tag` | yes | The tag, for example `7.0.1`. |

## Outputs

| Output | Description |
|---|---|
| `release-version` | The tag. |
| `base-version` | The version without its milestone or release candidate. |
| `generation` | `<major>.<minor>.x`. |
| `hotfix` | `true` or `false`. |

## Secrets and permissions

None.

## Using it

```yaml
- id: versions
  uses: spring-io/spring-security-actions/compute-tag-versions@v1
  with:
    tag: ${{ github.ref_name }}
- run: echo "${{ steps.versions.outputs.generation }}"
```

## Running it locally

```shell
cd compute-tag-versions
npm ci
export GITHUB_OUTPUT=$(mktemp)
env 'INPUT_TAG=7.1.0-RC1' node src/index.js
cat "$GITHUB_OUTPUT"
```

`npm test` runs its tests.
