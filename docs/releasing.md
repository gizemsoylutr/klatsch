# Releasing Klatsch

A release is a GitHub release `vX.Y.Z`. Publishing it starts two workflows, each waiting for the author's approval in its own environment:

- [`release.yml`](../.github/workflows/release.yml) publishes the npm package `klatsch` (environment `npm`).
- [`deploy.yml`](../.github/workflows/deploy.yml) builds the container image and rolls it out to klatsch.dev (environment `production`, see [self-hosting](self-hosting.md#deploying-from-github-actions-the-reference-instance)).

The MCP Registry entry and the Claude Code plugin are updated by hand, below.

## One-time setup

### npm Trusted Publishing

The workflow has no npm token. npm trusts this one workflow, in this one repository and environment, through GitHub's OIDC token, and attaches a [provenance statement](https://docs.npmjs.com/generating-provenance-statements) to each version.

1. The package name `klatsch` is already registered to the npm account `gizemsoylutr` (a 0.0.1 placeholder). Sign in to npmjs.com as that account, with two-factor authentication on.
2. Open https://www.npmjs.com/package/klatsch/access → **Trusted Publisher** → **GitHub Actions**, and enter exactly:
   - Organization or user: `gizemsoylutr`
   - Repository: `klatsch`
   - Workflow filename: `release.yml`
   - Environment name: `npm`
3. On the same page, under **Publishing access**, choose **Require two-factor authentication and disallow tokens**. Trusted Publishing keeps working; no token can publish.
4. Revoke any old automation or publish tokens for the account that are no longer needed (npmjs.com → Access Tokens).

Requirements npm checks at publish time: npm CLI 11.5.1 or newer (Node 26 ships it), `repository.url` in `package.json` matching this repository (it does), and a GitHub-hosted runner. **Provenance needs a public repository:** publish the first release after the repository is public.

### GitHub environment `npm`

Settings → Environments → **New environment** `npm`:

- **Required reviewers:** `gizemsoylutr`. Leave "Prevent self-review" off, so you can approve your own release.
- **Deployment branches and tags:** "Selected branches and tags", add the tag rule `v*`. A release runs on its tag, so nothing else can reach the environment.
- No secrets or variables: the workflow needs none.

The `production` environment for the deploy is described in [self-hosting](self-hosting.md#deploying-from-github-actions-the-reference-instance).

### Required before going public: a fresh history

The private history can hold what was never meant to be public (earlier drafts, experiments, notes in commit messages). Do not flip the existing repository to public as it is. Either:

1. **Fresh history in the same repository** (only if it has never had pull requests: their `refs/pull/*` keep old commits reachable and cannot be deleted by a push): run [`scripts/fresh-history.sh`](../scripts/fresh-history.sh) with a clean working tree. It makes one signed, signed-off commit of the current tree on a new orphan branch and prints, in order, the commands to keep a private backup (`git bundle create ../klatsch-private-history.bundle --all`, first), force-push it as `main`, and delete the other branches and tags. It pushes nothing itself.
2. **A new repository** (the safe choice when the private one has pull requests, releases or workflow runs from the old history): rename the private one (for example `klatsch-private`), create a new empty `gizemsoylutr/klatsch`, and push only the branch `fresh-history.sh` made, as `main`. Then set it up as below.

Either way, also delete old releases, workflow runs and container image versions built from the old history, and check the result with a fresh clone (`git log --all --oneline` shows one commit) before changing the visibility.

### Repository settings before going public

- Settings → Code security → **Private vulnerability reporting**: enable (SECURITY.md points there).
- Settings → General → Features: Issues on; Discussions as you like. The issue templates are in `.github/ISSUE_TEMPLATE/`.
- Settings → Branches: protect `main` (pull request required, status checks `test`, `secrets`, `dependencies` required, signed commits if you want them).
- GitHub Sponsors: `.github/FUNDING.yml` names `gizemsoylutr`; the Sponsor button appears once Sponsors is set up for the account (https://github.com/sponsors), until then GitHub ignores the file.

## Each release

1. Update the version in every place that names it (`test/release.test.ts` fails if they differ):
   - `npm version X.Y.Z --no-git-tag-version` (`package.json` and `package-lock.json`)
   - `server.json`: `version` and `packages[0].version`
   - `plugin/.claude-plugin/plugin.json`: `version`
   - `plugin/.mcp.json`: `klatsch@X.Y.Z` in the server's `args`
2. Move the `Unreleased` notes in `CHANGELOG.md` under `## X.Y.Z (date)`.
3. Run the checks from CONTRIBUTING.md and `npm run pack:check`; commit with sign-off and merge to `main`.
4. Create the release: GitHub → Releases → **Draft a new release**, tag `vX.Y.Z` on `main`, notes from the changelog, **Publish release**. Mark it as a pre-release to publish under the npm dist-tag `next` instead of `latest` (the deploy skips pre-releases).
5. Approve the `npm` and `production` deployments on the workflow runs.
6. Check: `npm view klatsch version`, the provenance badge on https://www.npmjs.com/package/klatsch, and `npx klatsch@X.Y.Z` on a clean machine.
7. Publish the MCP Registry entry (below).

## MCP Registry

[`server.json`](../server.json) describes Klatsch for the official [MCP Registry](https://registry.modelcontextprotocol.io): the hosted endpoint `https://klatsch.dev/mcp` and the npm package (which serves MCP at `http://127.0.0.1:7417/mcp` once `klatsch up` runs). Both need an agent token as a bearer token. The schema is pinned to `https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json`, the current one when this was written; check https://github.com/modelcontextprotocol/registry/tree/main/docs/reference/server-json before publishing and move to a newer dated schema if there is one.

The name `dev.klatsch/klatsch` is in the namespace of the domain `klatsch.dev`, so the registry checks that you control that domain, by a DNS TXT record. The npm package is checked by `mcpName` in `package.json`, which is already set; publish to npm first.

### Once: the DNS key

Ed25519 needs OpenSSL 3 (on macOS: `brew install openssl@3` and use `$(brew --prefix openssl@3)/bin/openssl` below; the system LibreSSL fails).

```sh
openssl genpkey -algorithm Ed25519 -out mcp-registry-key.pem
chmod 600 mcp-registry-key.pem
PUBLIC_KEY="$(openssl pkey -in mcp-registry-key.pem -pubout -outform DER | tail -c 32 | base64)"
echo "klatsch.dev. IN TXT \"v=MCPv1; k=ed25519; p=${PUBLIC_KEY}\""
```

Add that TXT record at the **apex** `klatsch.dev` (not under a subdomain such as `_mcp-registry`). Keep `mcp-registry-key.pem` outside the repository, in your password manager; anyone with it can publish under `dev.klatsch/*`. When you rotate the key, remove the old TXT record.

### Each release

Install `mcp-publisher` (`brew install mcp-publisher`, or a release binary from https://github.com/modelcontextprotocol/registry/releases), then, in the repository:

```sh
PRIVATE_KEY="$(openssl pkey -in /path/to/mcp-registry-key.pem -noout -text | grep -A3 "priv:" | tail -n +2 | tr -d ' :\n')"
mcp-publisher login dns --domain klatsch.dev --private-key "${PRIVATE_KEY}"
mcp-publisher publish
```

Check it: `curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=dev.klatsch/klatsch"`.

## Claude Code plugin

The plugin lives in [`plugin/`](../plugin) and the marketplace that lists it in [`.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json), so this repository is its own marketplace: people install it with

```text
/plugin marketplace add gizemsoylutr/klatsch
/plugin install klatsch@klatsch
```

(see [the plugin page](claude-code-plugin.md) for the local scope and the token).

Claude Code pins the plugin to the `version` in `plugin.json`; users get a new one when that changes on `main`. Check it before a release with `claude plugin validate plugin` and `claude plugin validate .`.
