# ensure-milestone

Creates a milestone in a repository if it has none of that title (open or closed), with the title and the due date, if one is given, and nothing else: no description. With a due date, a milestone that exists is changed to be due that day, at noon UTC. Without one, it is not changed.

The release branches workflow uses it for a frozen branch: every OSS version (`7.0.1`) is also a milestone of the commercial repository, so that the issues of the fixes that only customers get, such as the ones for a CVE, have a milestone of the version that has them. It is due when the OSS milestone is, and follows it if that changes.

## Inputs

| Input | Required | What it is |
|---|---|---|
| `repository` | yes | `owner/repo` that has to have the milestone, the commercial repository. |
| `milestone` | yes | Its title, `7.0.1`. |
| `due-date` | no | Its due date, `YYYY-MM-DD`: the due date of the OSS milestone. |
| `token` | yes | A token that can write the milestones of the repository. |

## Outputs

`created`: `true` if the milestone was created, which is also said in a notice, **Milestone created**. `changed`: `true` if the due date of a milestone that existed was changed, said in the notice **Milestone due date**. `milestone-url`: its URL.

## Trying it

`npm ci`, then `npm test`: the tests need no network.
