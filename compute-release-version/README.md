# compute-release-version

Works out the version a snapshot version is going to be released as, and when, from the milestones of a repository. It knows nothing about the project it runs in, so it can be used by any project that plans its releases with milestones.

## How it decides

The candidate is the snapshot version without `-SNAPSHOT`.

- If the candidate does not end with `.0`, it is the release version: `7.0.1-SNAPSHOT` is released as `7.0.1`, and the hotfix `7.0.1.1-SNAPSHOT` as `7.0.1.1`. The milestone with that exact title must exist in `milestone-repository`. The release workflow gives the OSS repository for a release, and the commercial repository for a hotfix, which is only released from there.
- If it ends with `.0`, the version is not released as itself first: `7.1.0-SNAPSHOT` is released as `7.1.0-M1`, `7.1.0-M2`, ... `7.1.0-RC1`, and then as `7.1.0`. The release version is the **open** milestone with the earliest due date of those. The title must match `7.1.0` or `7.1.0-M<n>` or `7.1.0-RC<n>` exactly, so `7.1.01` and `7.1.0.1` are not matches.

The due date is the date of the due date of the milestone in UTC. GitHub keeps only the date of a milestone, and answers with it as midnight UTC (`2026-11-19T00:00:00Z`). Setting it is where the time zone matters: GitHub reads what it is given in the time zone of your account, so `2026-11-19T00:00:00Z` set by a user in the Americas is stored as the 18th (this was measured). Set a milestone due at noon UTC (`2026-11-19T12:00:00Z`), which is the same day in every time zone, as the tutorial does.

## The release train of a milestone

A milestone of a commercial repository (a hotfix, or a long-term support version) is not due on the date of its release train, but on the commercial general availability of it, so its due date cannot name the train. Its description does, with a line (the key is not case sensitive):

```
Release Train: 2026.10.22
```

The name is the branch of the train in the release train repository. The rest of the description is free text, and the line can be anywhere in it. The name is the output `release-train` (empty if the description has no such line). A name that is not `YYYY.MM.DD`, or two lines that name different trains, fail the action.

## Inputs

| Input | Required | Description |
|---|---|---|
| `snapshot-version` | yes | The snapshot version, for example `7.0.1-SNAPSHOT`. It must end with `-SNAPSHOT`, and carries no milestone or release candidate. |
| `milestone-repository` | yes | The repository (`owner/repo`) whose milestones decide. |
| `milestone-token` | no | A token that can read its milestones. Without one, the request is unauthenticated, which only works for a public repository, and is rate limited. |
| `require-due-date` | no, `true` | Whether the milestone must have a due date. |
| `release-only` | no, `false` | Whether a `.0` version is only found if its next release is the version itself (`7.2.0`), and not a milestone or a release candidate (`7.2.0-RC1`): the release workflow gives it for a hotfix, which is only made of the release itself. Otherwise it ends as if there were no milestone, with the notice **No release**, and `found` is `false`. |
| `require-release-train` | no, `false` | Whether the description of the milestone must name its release train. If it does not, the action fails, and the summary says to add the line. |
| `kind` | no, `frozen` | The kind of branch that is built: `frozen`, `active` or `lts`. It decides what the summary tells to do: for `frozen` (OSS milestone) and `active` (the OSS milestone of the version that a hotfix fixes, or the milestone of the hotfix in the commercial repository) give a due date on the date of a train; for `lts` (commercial milestone) add the line `Release Train: <train>` to its description. Only a commercial version names its train. |
| `fail-if-missing` | no, `true` | Whether the action fails if the milestone does not exist. If `false`, it ends successfully with the notice **No milestone**, which says which milestone is missing and in which repository, and the output `found` is `false`. A milestone that exists without a due date is still an error. |

## Outputs

| Output | Description |
|---|---|
| `found` | `true` if the milestone exists. `false` if it does not and `fail-if-missing` is `false`: then the two outputs below are empty. |
| `release-version` | The title of the milestone: `7.0.1`, or `7.1.0-RC1`. |
| `due-date` | Its due date, `YYYY-MM-DD` (UTC). Empty if it has none and `require-due-date` is `false`. |
| `release-train` | The release train that the description names, `2026.10.22`. Empty if it names none, and if the milestone does not exist. |
| `milestone-url` | The URL of the milestone on GitHub (`https://github.com/<owner>/<repo>/milestone/<number>`). Empty if it does not exist. |

## Fails when

- the version is not a snapshot version, or is not `<major>.<minor>.<patch>[.<hotfix>]-SNAPSHOT`
- the milestone does not exist (for a `.0` version: there is no open milestone of its releases), unless `fail-if-missing` is `false`. Then it ends with a notice, and `found` is `false`.
- the milestone has no due date, unless `require-due-date` is `false`
- the description names a release train that is not `YYYY.MM.DD`, or two different ones, or (with `require-release-train`) none
- GitHub answers with an error. A `404` means the repository does not exist, or the token cannot read it.

When the milestone does not exist, has no due date, or (with `require-release-train`) does not name its train, the step fails, and its summary says how to add the version to a release train, for the `kind` of the branch:

- `frozen`: create the milestone in the OSS repository (GitHub cannot prefill its title, so the text names it), or edit it, with a due date on the date of a train.
- `lts`: create or edit the milestone in the commercial repository, with the line `Release Train: 2026.11.19` in its description. The workflow sets its due date from the train.
- `active`: a hotfix (`7.0.1.1`) is in the train of the OSS version that it fixes (`7.0.1`), which the due date of the OSS milestone gives (the summary asks for that milestone, with a due date). The milestone of the hotfix is in the commercial repository, and any due date will do, as the workflow sets it.

## Secrets and permissions

The action only reads milestones.

- For a **public** repository, no token is needed. `${{ secrets.GITHUB_TOKEN }}` is enough, and avoids the rate limit of unauthenticated requests. The workflow needs no extra permission.
- For a **private** repository, the token needs to read its issues and milestones:
** a fine-grained personal access token: **Issues: Read-only** on that repository
** a classic personal access token: the `repo` scope
+
Create it at https://github.com/settings/personal-access-tokens (fine-grained) or https://github.com/settings/tokens (classic), and store it as a secret of the repository the workflow runs in. The release workflow reads the milestones of a release (the public OSS repository) with `GITHUB_TOKEN`, and the milestone of a hotfix (the private commercial repository) with its secret `RELEASE_AUTOMATION_TOKEN`, in its plan job, with `fail-if-missing` set to `false`: a version without a milestone ends the run with a notice, and builds nothing.

## Using it

```yaml
- id: release
  uses: spring-io/spring-security-actions/compute-release-version@v1
  with:
    snapshot-version: 7.0.1-SNAPSHOT
    milestone-repository: ${{ github.repository_owner }}/spring-merge
    milestone-token: ${{ secrets.GITHUB_TOKEN }}
- run: echo "${{ steps.release.outputs.release-version }} is due ${{ steps.release.outputs.due-date }}"
```

## Running it locally

It is an ordinary Node program (Node 24). `npm ci` once in this directory, then run it with its inputs as `INPUT_<NAME>` variables, which is how GitHub passes them, and the file of its outputs as `GITHUB_OUTPUT`:

```shell
cd compute-release-version
npm ci
export GITHUB_OUTPUT=$(mktemp)
env 'INPUT_SNAPSHOT-VERSION=7.0.1-SNAPSHOT' \
    'INPUT_MILESTONE-REPOSITORY=your-github-user/spring-merge' \
    "INPUT_MILESTONE-TOKEN=$(gh auth token)" \
    node src/index.js
cat "$GITHUB_OUTPUT"
```

`GITHUB_API_URL` points it to another server than GitHub. `test/support/fake-github.js` is a small fake of the milestones endpoint, with the milestones of the tutorial (`test/fixtures/milestones.json`):

```shell
node test/support/fake-github.js 8123 &
env GITHUB_API_URL=http://127.0.0.1:8123 'INPUT_SNAPSHOT-VERSION=7.1.0-SNAPSHOT' \
    'INPUT_MILESTONE-REPOSITORY=tutorial/spring-merge' \
    node src/index.js
kill %1
```

`npm test` runs its tests, which need no network and no token.
