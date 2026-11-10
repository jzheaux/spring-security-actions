# deploy-schema

A reusable composite action that sets up a JDK and runs the `deploySchema` task of the [`spring-security-release-tools`](https://github.com/spring-io/spring-security-release-tools) Gradle plugins, which copies the project's XML schema files to the docs host.

## Caller contract

- The workflow **must** run `actions/checkout` before using this action, at the ref whose schema should be deployed (for a release, its tag), since the task deploys what is checked out.
- The repository **must** contain a Gradle wrapper (`gradlew` and `gradle/wrapper`) and apply the plugin that provides `deploySchema`.
- The docs host credentials are controlled entirely by ambient environment variables set on the calling step, not by inputs to this action — see the example below. The plugin reads them as the project properties `deployDocsSshKey`, `deployDocsSshUsername` and `deployDocsHost`, which Gradle also reads from `ORG_GRADLE_PROJECT_*` variables.
- Schemas are only published for OSS releases, so the caller decides whether to run this action at all (see [compute-build-environment](https://github.com/spring-io/spring-security-actions/tree/main/compute-build-environment) and its `release-channel` output).

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `java-version` | No | `17` | The Java version to use. |

## Example

```yaml
- uses: actions/checkout@v4
  with:
    ref: ${{ inputs.version }}

- name: Deploy Schema
  if: needs.setup.outputs.release-channel == 'oss'
  uses: spring-io/spring-security-actions/deploy-schema@v1
  with:
    java-version: '25'
  env:
    ORG_GRADLE_PROJECT_deployDocsSshKey: ${{ secrets.DOCS_SSH_KEY }}
    ORG_GRADLE_PROJECT_deployDocsSshUsername: ${{ secrets.DOCS_USERNAME }}
    ORG_GRADLE_PROJECT_deployDocsHost: ${{ secrets.DOCS_HOST }}
```

## Related

- [dispatch-deploy-docs](https://github.com/spring-io/spring-security-actions/tree/main/dispatch-deploy-docs) — the companion action that deploys the reference documentation.
- [run-gradle](https://github.com/spring-io/spring-security-actions/tree/main/run-gradle) — the action this one runs Gradle with.
