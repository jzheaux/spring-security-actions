# map-train-versions

Works out which versions of a Gradle version catalog (`gradle/libs.versions.toml`) the release train asks to change, and to what. It only decides: `update-versions` makes the changes.

The versions of the catalog are named after the project of the train that releases them: `spring-framework = "7.0.9"` is the version of the project `spring-framework`, and the train lists its versions in `release-versions.json`. A version that is not a project of the train (`org-aspectj`) is not touched, and a project of the train that is not in the catalog (`spring-boot`) is not looked at.

## How it decides

For every version of the `[versions]` section of the catalog that is a project of the train:

. **The candidates** are the train versions of the same generation, the first two numbers: for `7.0.9` that is `7.0`, and for the calendar version `2025.0.7` it is `2025.0`. There is none: the version is left alone.
. **The newest candidate is chosen.** A hotfix (four numbers, `7.0.10.1`) is only chosen if `prefer-hotfix` is `true` and the train has one for the generation. Otherwise it is the newest that is not a hotfix (`7.0.10`).
. **It must have joined the train**, if `require-joined` is `true`: `train.yml` has the `joined` commit hash of that version of that project. Joined is enough, it does not need to be ready. A version that has not joined is left alone.
. **The suffix is added**, if there is one: `hotfix-suffix` to a hotfix, `suffix` to anything else, so `7.0.10` with `-INTERNAL-SNAPSHOT` is `7.0.10-INTERNAL-SNAPSHOT`. A milestone or release candidate is dropped first, because a snapshot never carries one: the snapshot of `7.1.0-RC1` is `7.1.0-SNAPSHOT`.
. **The catalog has that version already** (with the suffix): it has been updated, and is left alone. This also is how a rerun does not change twice. So it is if the catalog has the version of the train itself (`7.0.10`) and a snapshot is asked for: it has been released, there is nothing to take a snapshot of.
. **The catalog has a newer version than the train:** it fails. Something is wrong, and the action does not downgrade. The catalog is compared with the version of the train, and not with its snapshot: `7.1.0-M3` is not newer than the snapshot of `7.1.0-RC1`, which comes after it, though a snapshot sorts below the milestones of its version.

Versions are ordered by their numbers (`7.0.10` is older than `7.0.10.1`), and then by their qualifier: a snapshot (`-SNAPSHOT` and `-INTERNAL-SNAPSHOT` are the same here) is older than the milestones (`-M1`) of a version, which are older than its release candidates (`-RC1`), which are older than the version itself. A version of any other form (`1.0.18.RELEASE`) cannot be ordered and fails, with the version in the message.

## The same train, four ways

With the practice train `2026.11.19` and the versions of the template (`7.0.9` for `spring-framework`, and so on), the options of the release workflow give:

|  | `spring-framework` | `micrometer` | `spring-data-bom` |
|---|---|---|---|
| the release branch (no options) | `7.0.10` | `1.16.8` | `2025.1.8` |
| the release branch of a hotfix (`prefer-hotfix`) | `7.0.10.1` | `1.16.8` (there is no hotfix) | `2025.1.8.1` |
| the snapshot branch of a frozen embargoed branch (`suffix: -INTERNAL-SNAPSHOT`) | `7.0.10-INTERNAL-SNAPSHOT` | `1.16.8-INTERNAL-SNAPSHOT` | `2025.1.8-INTERNAL-SNAPSHOT` |
| the snapshot branch of a hotfix (`prefer-hotfix`, `hotfix-suffix: -SNAPSHOT`, `suffix: -INTERNAL-SNAPSHOT`) | `7.0.10.1-SNAPSHOT` | `1.16.8-INTERNAL-SNAPSHOT` (no hotfix, so the plain version) | `2025.1.8.1-SNAPSHOT` |

## Inputs

| Input | Default | Description |
|---|---|---|
| `release-versions-file`, or `release-versions` | required | `release-versions.json` of the train, as `load-train` writes it: the path of a file, or its JSON. |
| `train-file`, or `train` |  | `train.yml` of the train as JSON, as `load-train` writes it. Needed if `require-joined` is `true`. A real train is too large for an input (it is an environment variable): use the file. |
| `toml-path` | `gradle/libs.versions.toml` | The version catalog. Only lines of the form `name = "value"` of its `[versions]` section are read. |
| `prefer-hotfix` | `false` | Whether to choose a hotfix version if there is one. |
| `require-joined` | `true` | Whether a version must have joined the train. |
| `suffix`, `hotfix-suffix` | empty | Added to the version chosen, see above. |

## Outputs

| Output | Description |
|---|---|
| `versions` | The versions to change, as a JSON object from the name in the catalog to the new version: `{"spring-framework":"7.0.10","micrometer":"1.16.8"}`. `{}` if there are none. |
| `count` | How many. |

What it did for every version of the train is in its log.

## Fails when

- a version of the catalog, or of the train in its generation, cannot be read as a version
- the catalog has a newer version than the train
- a file does not exist, or is not JSON
- `require-joined` is `true` and there is no train

## Secrets and permissions

None. It reads files, and calls nothing.

## Overriding the suffix

The input `snapshot-suffix-overrides` decides the suffix of a project, or of a version of it, whatever `suffix` and `hotfix-suffix` say. One rule per line, or separated by commas:

```
spring-framework=-SNAPSHOT
spring-data-bom@2025.1.x=-INTERNAL-SNAPSHOT
spring-framework@7.0.10.1=-INTERNAL-SNAPSHOT
```

- The version is the one of the project in the train (what `release-versions` lists), and not the name of the train: the version that is chosen for the catalog, a hotfix included. It is a version (`7.0.10`, `7.0.10.1`) or a generation (`7.0.x`). No patterns for the project.
- The most specific rule wins: the version, then the generation, then the project. It applies to a hotfix too, so `spring-framework=-INTERNAL-SNAPSHOT` makes the snapshot of a hotfix `7.0.10.1-INTERNAL-SNAPSHOT`.
- The suffix is `-SNAPSHOT` or `-INTERNAL-SNAPSHOT`. A rule that cannot be read, one for a project that is not in the train, and two for the same project and version fail the run with the rule in the message, so that a typo does not change what is built.
- The log says what it did: `spring-framework 7.0.9: to 7.0.10.1-INTERNAL-SNAPSHOT (override spring-framework=-INTERNAL-SNAPSHOT)`.

`release-branches.yml` passes its input `snapshot-suffix-overrides` to the step of the snapshot branch only. The caller of that workflow gives it from a repository variable (`vars.SNAPSHOT_SUFFIX_OVERRIDES`): the `env` context is not available in the `with` of a job that calls a workflow. Locally, it is `INPUT_SNAPSHOT-SUFFIX-OVERRIDES`.

## Using it

```yaml
- id: map
  uses: spring-io/spring-security-actions/map-train-versions@v1
  with:
    release-versions-file: ${{ steps.train.outputs.release-versions-file }}
    train-file: ${{ steps.train.outputs.train-file }}
    prefer-hotfix: ${{ steps.version.outputs.hotfix }}
- run: echo '${{ steps.map.outputs.versions }}'
```

## Running it locally

It is an ordinary Node program (Node 24). `npm ci` once in this directory, then run it with its inputs as `INPUT_<NAME>` variables. In a workflow, `load-train` writes the two files of the train. Here the practice train of the tests, `test/fixtures/train/`, stands for them, with the version catalog of the tests:

```shell
cd map-train-versions
npm ci
export GITHUB_OUTPUT=$(mktemp)
# load-train writes train.yml as JSON: do the same for the one of the tests
node --input-type=module -e 'import fs from "node:fs"; import { parse } from "yaml"; fs.writeFileSync("/tmp/train.json", JSON.stringify(parse(fs.readFileSync("test/fixtures/train/2026.11.19/train.yml", "utf8"))))'
env 'INPUT_RELEASE-VERSIONS-FILE=test/fixtures/train/2026.11.19/release-versions.json' \
    'INPUT_TRAIN-FILE=/tmp/train.json' \
    'INPUT_TOML-PATH=test/fixtures/libs.versions.toml' \
    'INPUT_PREFER-HOTFIX=true' \
    node src/index.js
cat "$GITHUB_OUTPUT"
```

Change `INPUT_PREFER-HOTFIX`, and add `INPUT_SUFFIX=-INTERNAL-SNAPSHOT` or `INPUT_HOTFIX-SUFFIX=-SNAPSHOT`, to get the other lines of the table above. Edit a version of `test/fixtures/libs.versions.toml` to what the train has, or higher, to see a version that is left alone, and a failure. `npm test` runs its tests, which need no network and no token.
