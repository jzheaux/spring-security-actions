# merge-release

Merges the release that a hotfix fixes (`release/7.0.1-SNAPSHOT`) into the branch that is checked out, so that the hotfix `7.0.1.1` is the release plus the fixes of the active embargoed branch. the release workflow runs it first on the snapshot branch of a hotfix.

## What it does

- The merge is a merge commit, `Merge release/7.0.1-SNAPSHOT into embargoed/7.0.1.1-SNAPSHOT`, signed off with the identity that git is set up with (`git-identity` sets it), even if the release could be fast forwarded to. It is not signed with a key.
- It merges the branch of the remote, `origin/release/7.0.1-SNAPSHOT`, as it was when the repository was checked out. A branch of that name in the clone is not used.
- **No release yet:** the frozen embargoed branch has not been pushed, so `release/7.0.1-SNAPSHOT` does not exist. That is a warning (`No release to build the hotfix on`), nothing is merged, and `merged` is `false`. The hotfix is built from the active embargoed branch alone.
- **Already in the branch:** nothing is merged, `merged` is `up-to-date`.
- **Both sides changed the same lines:** the checked out branch (the active embargoed branch, which has the fixes) wins, as with `git merge -X ours`. The files that both sides changed are said in a notice, `Changed on both sides`, so that is not silent.
- **A conflict that cannot be settled that way** (a file that one side deleted and the other changed, a binary file) fails. The merge is undone, and the error lists the files and says to merge the release into the active embargoed branch by hand (the merge forward), push, and the hotfix is built again.

## Inputs

| Input | Default | Description |
|---|---|---|
| `release` | required | The branch of the release, for example `release/7.0.1-SNAPSHOT`. |
| `path` | `.` | The directory of the git repository. |

## Outputs

| Output | Description |
|---|---|
| `merged` | `true`, `false` (there is no such release) or `up-to-date`. |

## Secrets and permissions

None. It works on the clone that is checked out, and does not push. The checkout needs the history of the branches (`fetch-depth: 0`).

## Using it

```yaml
- uses: spring-io/spring-security-actions/merge-release@v1
  with:
    release: release/7.0.1-SNAPSHOT
```

## Running it locally

It merges in a repository, so try it in a clone that is on the branch of the hotfix, with an identity set:

```shell
cd merge-release
npm ci
export GITHUB_OUTPUT=$(mktemp)
env 'INPUT_RELEASE=release/7.0.1-SNAPSHOT' 'INPUT_PATH=/path/to/a/clone' node src/index.js
cat "$GITHUB_OUTPUT"
```

`npm test` runs its tests, with real git in temporary repositories.
