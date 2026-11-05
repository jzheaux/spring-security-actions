# compute-tag-versions

Works out the release version and the snapshot version of a tag. It knows nothing about repositories: it only changes text.

## What it does

- A leading `v` is not part of the release version: `v7.0.1` releases `7.0.1`. A tag without it is the release version as it is.
- The snapshot version is the release version without its milestone (`-M1`) or release candidate (`-RC1`), and with `-SNAPSHOT`.
- It fails if the tag is empty, or is only a `v`.

| Tag | `release-version` | `snapshot-version` |
|---|---|---|
| `v7.0.1` | `7.0.1` | `7.0.1-SNAPSHOT` |
| `7.0.1.1` | `7.0.1.1` | `7.0.1.1-SNAPSHOT` |
| `v7.1.0-M2` | `7.1.0-M2` | `7.1.0-SNAPSHOT` |
| `7.1.0-RC1` | `7.1.0-RC1` | `7.1.0-SNAPSHOT` |

## Inputs

| Input | Default | Description |
|---|---|---|
| `tag` | required | The tag, for example `v7.0.1`. |

## Outputs

| Output | Description |
|---|---|
| `release-version` | The version of the release. |
| `snapshot-version` | The version that follows the release. |

## Secrets and permissions

None.

## Using it

```yaml
- id: versions
  uses: spring-io/spring-security-actions/compute-tag-versions@v1
  with:
    tag: ${{ github.ref_name }}
- run: echo "${{ steps.versions.outputs.snapshot-version }}"
```

## Running it locally

```shell
cd compute-tag-versions
npm ci
export GITHUB_OUTPUT=$(mktemp)
env 'INPUT_TAG=v7.1.0-RC1' node src/index.js
cat "$GITHUB_OUTPUT"
```

`npm test` runs its tests.
