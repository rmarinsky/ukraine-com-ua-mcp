# Releasing

Tag-driven release workflow for `@rmarinsky/ukraine-com-ua-mcp`.

A tag matching `v*` triggers `.github/workflows/release.yml`, which:

1. **validate** — typecheck, lint, tests, and a *tag-vs-package.json version
   match check* (catches tagging `v0.2.0` while `package.json` still says
   `0.1.0`).
2. **binaries** — compiles single-file binaries for `darwin-arm64`,
   `darwin-x64`, `linux-x64` via `bun build --compile`.
3. **release** — creates a GitHub Release with auto-generated notes and the
   compiled binaries attached.
4. **npm-publish** — `npm pack --dry-run` (preview), `npm publish --dry-run`
   (auth/scope check), then real `npm publish --access public --provenance`.

## One-time setup

### 1. Create an npm Automation token

Go to <https://www.npmjs.com/settings/~/tokens> → **Generate New Token** →
**Automation** (NOT "Publish" — Automation works with 2FA-enabled accounts in
CI). Name it something like `gha-ukraine-com-ua-mcp`.

### 2. Store it as `NPM_TOKEN` repo secret

<https://github.com/rmarinsky/ukraine-com-ua-mcp/settings/secrets/actions/new>

- Name: `NPM_TOKEN`
- Value: paste the token from step 1
- Add secret

GitHub encrypts the value; even you can't read it back. Workflow reads it via
`${{ secrets.NPM_TOKEN }}`.

### 3. Verify the npm scope is yours (only for the very first release)

```bash
npm whoami --registry=https://registry.npmjs.org/   # should print: rmarinsky
npm access ls-packages                              # check that @rmarinsky scope is yours
```

If the `@rmarinsky` scope is unclaimed, the first `npm publish` will create
it automatically under your account.

## Cutting a release

```bash
# 1. Bump version in package.json + create a git tag in one step
npm version patch          # 0.1.0 → 0.1.1
# or: npm version minor   # 0.1.0 → 0.2.0
# or: npm version major   # 0.1.0 → 1.0.0
# or: npm version 0.2.0   # explicit version

# 2. Push commit + tag in one go (--follow-tags pushes only annotated tags)
git push --follow-tags
```

GitHub Actions runs the `release.yml` workflow automatically. Watch progress:

```bash
gh run watch --exit-status -R rmarinsky/ukraine-com-ua-mcp
# or just list:
gh run list -R rmarinsky/ukraine-com-ua-mcp
```

The release is "done" when the workflow's `release` and `npm-publish` jobs
both turn green. Verify:

```bash
# Public registry should now resolve the new version
npm view @rmarinsky/ukraine-com-ua-mcp version --registry=https://registry.npmjs.org/

# GitHub Release should exist
gh release view v0.1.1 -R rmarinsky/ukraine-com-ua-mcp
```

## Pre-release safety net

`package.json` defines a `prepublishOnly` script:

```json
"prepublishOnly": "bun run validate && bun run build"
```

That means a manual `npm publish` on your laptop will refuse to run unless
typecheck, lint, tests, and build all pass. It's a belt-and-braces guard for
the case where you accidentally publish without going through CI.

## If something goes wrong

### Workflow failed at "Verify tag matches package.json version"

You tagged a version that doesn't match `package.json`. Fix:

```bash
git tag -d vX.Y.Z                    # delete local tag
git push origin :refs/tags/vX.Y.Z    # delete remote tag
npm version X.Y.Z --allow-same-version
git push --follow-tags
```

### Workflow failed at "Publish dry-run"

Most common causes:
- `NPM_TOKEN` secret is missing or invalid → regenerate at npmjs.com, re-add
  to GitHub secrets.
- Token doesn't have publish permission for `@rmarinsky` scope → make sure
  you generated an *Automation* token from the right account.
- Network glitch → re-run the workflow.

### Workflow failed at the real publish (after dry-run passed)

This is rare (race condition) but possible. The version may have already
been published. `npm publish` is **idempotent on success but errors on a
duplicate version**. Check:

```bash
npm view @rmarinsky/ukraine-com-ua-mcp@X.Y.Z
```

If it returns the version, it's actually published — the error was misleading.
If not, bump to the next patch version and re-tag.

### Need to "unpublish" a version

`npm unpublish` is restricted within 72 hours of publishing. After that,
the canonical way is to deprecate:

```bash
npm deprecate @rmarinsky/ukraine-com-ua-mcp@X.Y.Z "Reason — please use Y.Y.Z"
```

This leaves the version installable (so existing lockfiles don't break) but
warns users on `npm install`.

## Pinned versions (FYI)

The release workflow pins to GitHub Action major versions (`@v4`, `@v2`).
Major versions get backwards-compatible updates from upstream — generally
safe. Pin to exact SHAs only if you want maximum reproducibility at the
cost of manual upgrades.
