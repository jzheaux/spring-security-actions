# dispatch-deploy-docs

A reusable composite action that dispatches the workflow that deploys a project's documentation (`gh workflow run deploy-docs.yml --ref docs-build`). It only starts the workflow; it does not wait for it.

## Caller contract

- The repository **must** have the workflow (`deploy-docs.yml` by default) with a `workflow_dispatch` trigger, on the ref that is dispatched (`docs-build` by default).
- The token **must** be able to write to Actions. With the default `github.token`, the calling job needs `permissions: actions: write`. A dispatch made with `github.token` does start the workflow (`workflow_dispatch` is exempt from the rule that `github.token` events don't trigger workflows).
- No checkout is needed.

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `workflow` | No | `deploy-docs.yml` | The file name of the workflow to dispatch. |
| `ref` | No | `docs-build` | The branch or tag to run the workflow on. |
| `repository` | No | `${{ github.repository }}` | The repository (`owner/repo`) that has the workflow. |
| `token` | No | `${{ github.token }}` | The token that dispatches the workflow. |

## Example

```yaml
jobs:
  deploy-docs:
    runs-on: ubuntu-latest
    permissions:
      actions: write
    steps:
      - uses: spring-io/spring-security-actions/dispatch-deploy-docs@v1
```

## Related

- [deploy-schema](https://github.com/spring-io/spring-security-actions/tree/main/deploy-schema) — the companion action that deploys the schema files.
