# `dd-octo-sts-action`

This action federates the GitHub Actions identity token for a Github App token
according to the Trust Policy in the target organization or repository.

## Usage

Consider the following workflow in `my-org/my-repo`:

```yaml
permissions:
  id-token: write # Needed to federate tokens.

steps:
- uses: DataDog/dd-octo-sts-action@main
  id: octo-sts
  with:
    scope: your-org/your-repo # the target repository
    policy: foo # policy filename excluding `.sts.yaml`

- env:
    GITHUB_TOKEN: ${{ steps.octo-sts.outputs.token }}
  run: |
    gh repo list
```

The above will load a "trust policy" from `.github/chainguard/foo.sts.yaml` in
the repository `your-org/your-repo`.  Suppose this contains the following, then
workflows in `my-org/my-repo` will receive a token with the specified
permissions on `my-org/my-repo`.

```yaml
issuer: https://token.actions.githubusercontent.com
subject: repo:my-org/my-repo:ref:refs/heads/main

permissions:
  contents: read
  issues: write
```

Org-wide permissions are accessible by only providing the GitHub organization name as scope and referencing a policy in `your-org/.github` repo under `.github/chainguard/`.

## Pool Endpoint

The action supports application pools, which distribute requests across multiple
GitHub App installations for better throughput and rate limit isolation.

To use the pool endpoint, add the `pool_name` input:

```yaml
permissions:
  id-token: write # Needed to federate tokens.

steps:
- uses: DataDog/dd-octo-sts-action@main
  id: octo-sts
  with:
    scope: your-org/your-repo
    policy: foo
    pool_name: dd-octo-sts

- env:
    GITHUB_TOKEN: ${{ steps.octo-sts.outputs.token }}
  run: |
    gh repo list
```

The `scope` input works the same for both endpoints:
- `your-org/your-repo` for repository-scoped tokens
- `your-org` for organization-scoped tokens

For enterprise-scoped tokens, use `scope_enterprise` instead of `scope`:

```yaml
- uses: DataDog/dd-octo-sts-action@main
  id: octo-sts
  with:
    scope_enterprise: your-enterprise
    policy: foo
    pool_name: dd-octo-sts
```

If you need to target a specific application rather than a random one from the pool, use `application_id` instead of `pool_name`:

```yaml
- uses: DataDog/dd-octo-sts-action@main
  id: octo-sts
  with:
    scope: your-org/your-repo
    policy: foo
    application_id: your-app-id
```

## Debugging OIDC Claims

### Debug mode

Set `debug: true` to print the OIDC token claims without exchanging for a
GitHub App token. This is useful for diagnosing trust policy mismatches:

```yaml
- uses: DataDog/dd-octo-sts-action@main
  with:
    scope: your-org/your-repo
    policy: foo
    debug: true
```

The claims will appear in the step log and in the GitHub Step Summary. No
token exchange is attempted and the `token` output is not set.

### Re-run with debug logging

OIDC claims are also emitted as debug-level log messages on every run. To
view them without modifying your workflow file, use GitHub's
**"Re-run jobs" > "Enable debug logging"** option. The claims will appear
in the step's debug output prefixed with `OIDC claim:`.

### Inputs

| Input | Required | Description |
|-------|----------|-------------|
| `scope` | Yes (unless `scope_enterprise` is set) | `org/repo` for repository-scoped or `org` for organization-scoped tokens. |
| `policy` | Yes | Trust policy filename excluding `.sts.yaml`. |
| `pool_name` | No | Application pool name. Triggers the pool endpoint. Mutually exclusive with `application_id`. |
| `application_id` | No | Specific application ID. Triggers the pool endpoint. Mutually exclusive with `pool_name`. |
| `scope_enterprise` | No | Enterprise slug for enterprise-level tokens (pool endpoint only). Mutually exclusive with `scope`. |
| `debug` | No | When `true`, prints OIDC claims and exits without token exchange. Defaults to `false`. |
| `domain` | No | Octo STS instance domain. Defaults to `webhooks.build.datadoghq.com`. |
| `audience` | No | Octo STS audience. Defaults to `dd-octo-sts`. |

### Outputs

| Output | Description |
|--------|-------------|
| `token` | The federated GitHub App token. |
