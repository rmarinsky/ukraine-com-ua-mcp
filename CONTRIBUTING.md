# Contributing to ukraine-com-ua-mcp

Thanks for considering a contribution! This package is a small surface
wrapping a large undocumented API — the bulk of the work is *coverage* (more
endpoints) and *correctness* (matching what adm.tools actually accepts today).

## Setup

```bash
git clone https://github.com/rmarinsky/ukraine-com-ua-mcp.git
cd ukraine-com-ua-mcp
bun install
cp .env.example .env             # paste your token
bun run validate                 # typecheck + lint + tests
```

You need:

- Bun ≥ 1.1
- An `adm.tools` API token from <https://adm.tools/user/api/> (only required
  for integration tests; unit tests work without one)
- A test domain you don't mind poking at (only for `INTEGRATION_WRITE=1` mode)

## Adding a new endpoint

The standard recipe is **always the same five steps**:

1. **Client method** in `src/admtools.ts`. Typed inputs, snake_case form
   fields, optional fields only sent when defined.
2. **Tool registration** in `src/server.ts`:
   - English `title` and `description`.
   - Zod `inputSchema` with `.describe()` on every field.
   - Destructive operations require `confirm: z.literal(true)` and the
     description must instruct Claude to confirm with the human first.
   - Wrap destructive tools in `if (config.enableWriteTools) { … }`.
3. **CLI command** in `src/cli.ts` (optional but appreciated).
4. **Unit test** in `test/admtools.test.ts`:
   - Assert the URL hits the right `/action/<path>/`.
   - Assert the form body contains the exact field names.
   - Assert the response shape is unwrapped correctly.
5. **Docs**: flip the row in `docs/api-endpoints.md` from `⬜` to `✅`.

`bun run validate` must pass before opening a PR.

## Style and quality bar

- TypeScript strict mode. No `any` outside well-isolated unwrapping helpers.
- Biome handles formatting and lint — `bun run lint:fix` before committing.
- One responsibility per file in `src/`. Tools that share state (like the
  domain cache) live in `src/server.ts`.
- Keep tool descriptions ≤ 1500 characters but prefer clarity over brevity —
  these are the model's only documentation.
- Tests use mocked `fetch` only. No live API calls in CI.

## Integration tests

Live API tests are gated:

```bash
INTEGRATION=1 ADM_TOOLS_TOKEN=… bun test test/integration/

# write tests need an additional opt-in and a sacrificial domain id:
INTEGRATION=1 INTEGRATION_WRITE=1 TEST_DOMAIN_ID=12345 \
  ADM_TOOLS_TOKEN=… bun test test/integration/
```

Write tests must clean up after themselves (delete every record they create,
even if assertions fail). If you can't make a test reversible, gate it behind
its own env flag.

## Secrets and pre-commit

`.env` is in `.gitignore` from the first commit. The `AdmToolsClient` redacts
the token from any log line it writes. Please install
[gitleaks](https://github.com/gitleaks/gitleaks) and add a pre-commit hook:

```bash
gitleaks protect --staged
```

A leaked adm.tools token can move/delete your zones — treat it like a database
password.

## Commit style

- Imperative, present tense: `add ssl/crt/upload wrapper`, not `added` or `adds`.
- One logical change per commit; split refactors from new features.
- No `Co-Authored-By` lines unless someone actually paired with you.

## Releasing

Release engineering lives in `.github/workflows/release.yml`. Tag pushes match
`v*`:

```bash
# bump CHANGELOG.md and package.json
git tag v0.2.0
git push origin v0.2.0
```

CI compiles binaries for `darwin-arm64`, `darwin-x64`, `linux-x64`, attaches
them to the GitHub release, and publishes to npm under `@rmarinsky` scope.
