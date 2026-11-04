# ensure-milestone

Creates a milestone in a repository if it has none of that title, with a title and nothing else: no due date, no description. A milestone that exists, open or closed, is not changed.

The release branches workflow uses it for a frozen branch: every OSS version (`7.0.1`) is also a milestone of the commercial repository, so that the issues of the fixes that only customers get, such as the ones for a CVE, have a milestone of the version that has them.

## Inputs

| Input | Required | What it is |
|---|---|---|
| `repository` | yes | `owner/repo` that has to have the milestone, the commercial repository. |
| `milestone` | yes | Its title, `7.0.1`. |
| `token` | yes | A token that can write the milestones of the repository. |

## Outputs

`created`: `true` if the milestone was created, which is also said in a notice, **Milestone created**. `milestone-url`: its URL.

## Trying it

`npm ci`, then `npm test`: the tests need no network.
