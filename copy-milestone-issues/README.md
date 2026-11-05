# copy-milestone-issues

Copies the issues and the pull requests of a milestone of a repository, the source, to another repository, the destination, as issues, and comments on each original with the link to its copy. The two repositories have a milestone of the same title (the version, `7.0.1`).

The copy has what the original has, and nothing is added to it: the title, the body, the labels, the issue type, the assignees and the milestone, and it is closed if the original is. The comments, the reactions and the dates are not copied. **The copy says nothing of the source**: no header, no marker, no link and no author. Only the original links to the copy.

- **A pull request** is copied as an issue like any other: the diff, the commits, the branches and the reviews are not copied, and it has no issue type. Its copy is closed as completed if it was merged, and as not planned if it was closed without a merge.
- **A closed issue** has a closed copy, with the same reason (completed or not planned). An issue that was closed as a duplicate is closed as not planned: the issue that it duplicates is not carried over, as a duplicate needs one.
- **The body** is copied as it is, so a reference such as `#123` in it points to the issue 123 of the destination. It is not rewritten, as that would name the source. With `omit-body`, the copy has no body.
- **The assignees** of the copy are the ones of the original. GitHub drops, without an error, an assignee that cannot be assigned in the repository, so every assignee is checked before anything is copied: if one cannot be assigned in the destination, the action fails and lists them, with their issues, and copies nothing. Each copy is read back too, and a difference of assignees fails the run.
- **A run can be repeated.** The comment on an original is the only record of its copy, so an original that has it for the destination is skipped.

The order for an item is: the copy is created, the original gets its comment, and the copy is closed if it has to be. If a step fails, the error names the item, and what is left to do:

| It fails at | Left behind | What to do |
|---|---|---|
| the comment on the original | a copy that nothing links to, so another run would copy the original again | delete the copy, or comment on the original by hand (`Copied to owner/repo#n.`), and run again |
| closing the copy | an open copy of a closed original, which another run skips | close the copy |

## Inputs

| Input | Required | What it is |
|---|---|---|
| `source-repository` | yes | `owner/repo` that has the milestone. Its issues and pull requests are copied, and get the comment. |
| `destination-repository` | yes | `owner/repo` that the issues are copied to. It needs a milestone of the same title: the action fails if it has none (`ensure-milestone` makes one). |
| `milestone` | yes | The title of the milestone in both, `7.0.1`. |
| `omit-body` | no | `true` copies the issues without their body. The default is `false`, which copies it. |
| `token` | yes | A token that can read and comment on the issues and the pull requests of the source, and write the issues of the destination. Pass it as a secret. |

## Outputs

`copied`: how many were copied. `skipped`: how many were not, as their original has the comment already. A notice, **Issues copied**, says both.

## The comment on the original

```markdown
Copied to spring-projects/spring-security#1234.

<!-- copied-to: spring-projects/spring-security#1234 -->
```

The second line is what a run reads, and it is not shown on GitHub.

## Trying it

`npm ci`, then `npm test`: the tests need no network. They check what is created, commented and closed with a fake of GitHub, that nothing in a copy names the source, and that a run does not copy twice.
