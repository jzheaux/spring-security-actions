# list-branches

The branches that a code freeze works on, from the Spring projects API, the same data and the same rules as `spring-versions`: `GET https://api.spring.io/projects/<project>/generations`.

## What it does

- A generation is supported until its commercial support ends (the last day counts). It is **OSS** while its OSS support has not ended either, and **commercial** (long-term support) after that. A generation whose commercial support ended is dropped.
- The branch of a generation is its name (`7.0.x`), except for the newest OSS generation, which is `main`. A commercial generation (`6.5.x`) has its branch `embargoed/lts/6.5.x` in the commercial repository, or, if the generation is named otherwise than its branch (Spring Session's `2021.2.x` is `embargoed/lts/2.7.x`), the branch that has a version of its major and minor: `plan-freeze` and `plan-post-publish` find it, and this action only lists the generations.
- Both lists are in the order of the release of the generations (`initialReleaseDate` of the API), the oldest first: that is the order of the merges forward. It is not the order of the numbers, as `2021.2.x` of Spring Session is older than `3.4.x`. A generation that is supported and has no `initialReleaseDate` fails.

## Overrides

`branches` and `lts-branches` replace what the API says. Each one is checked, and every problem is reported together:

- every entry is a branch of the right kind (an OSS generation is not a long-term support one, and the other way round), and there are no duplicates,
- the order is the one of the release, oldest first (a branch is merged into the next one, never the other way round),
- the entries are a run of the discovered branches with **no gap**: you can drop the oldest or the newest, but not one in the middle, which would get no merge.

## Inputs

| Input | Default | Description |
|---|---|---|
| `project` | required | The slug in the API, `spring-security`. |
| `branches` | | The OSS branches to freeze, `7.1.x,main`. Empty: all the OSS generations. |
| `lts-branches` | | The commercial generations to freeze, `6.4.x,6.5.x`. Empty: all of them. |
| `api-url` | `https://api.spring.io` | The API. |

## Outputs

`oss-branches` (`7.0.x,7.1.x,main`) and `lts-branches` (`6.4.x,6.5.x`), separated by commas.

## Secrets and permissions

None.

## Trying it

`npm ci`, then `npm test` (no network). Against the API: `INPUT_PROJECT=spring-security GITHUB_OUTPUT=$(mktemp) node src/index.js`.
