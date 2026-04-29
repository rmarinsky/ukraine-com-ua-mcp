# ukraine-com-ua-mcp

> [Українською](README.uk.md)

Model Context Protocol (MCP) server for **ukraine.com.ua** — Ukraine's largest
hosting and domain registrar. Wraps their semi-official `adm.tools` HTTP API so
you can drive domains, DNS, mailboxes and SSL from any MCP client (Claude
Desktop, Claude Code, Cursor, …) in plain English.

> Status: **early but production-shaped** (v0.1.x). Tier 1–4 tools are
> implemented. The adm.tools API itself has no public OpenAPI spec and may
> change without notice — see [Limitations](#limitations).

## Why

ukraine.com.ua's web UI is fine for casual use but painful for routine work
like adding SPF/DKIM/DMARC, delegating DNS to Cloudflare, or auditing a stale
zone. This MCP server exposes those operations as tools an LLM can call after
you describe the change in chat. Same use cases as the official Cloudflare MCP
server, but for `.ua` and `.com.ua` zones managed at adm.tools.

## What it does

| Tool                            | What it wraps                  |
|---------------------------------|--------------------------------|
| `check_domain_availability`     | `domain/check`                 |
| `list_domains`                  | `dns/list` (cached 1h)         |
| `list_dns_records`              | `dns/records_list`             |
| `backup_dns_zone`               | `dns/records_list` + on-disk snapshot |
| `create_dns_record`             | `dns/record_add`               |
| `update_dns_record`             | `dns/record_edit`              |
| `delete_dns_record` 🔥          | `dns/record_delete`            |
| `restore_dns_zone` 🔥           | diff + replay from a backup    |
| `get_balance`                   | `billing/balance_get`          |

🔥 = destructive: requires `confirm: true` in the tool input. The
description tells the model to confirm with you in chat first.

All write tools also require a fresh `backup_id` from `backup_dns_zone` —
mutations are refused if the live zone no longer matches the snapshot.
See [Backup safety](#backup-safety) below.

The surface is intentionally narrow. adm.tools has removed several endpoints
upstream that older PHP references still document (NS edit, DNSSEC, MX preset,
domain register, mailbox CRUD, SSL — all return HTTP 400 «handler not found»
as of 2026-04-29). See [`docs/api-endpoints.md`](docs/api-endpoints.md) for
the full list and the graveyard. New endpoint? Probe live first
(`bun run src/cli.ts call <action>`), then PR.

## Output format

Tool responses follow MCP's dual-channel pattern:

- **`content[].text`** (what the model reads) — defaults to **TOON** ([Token-Oriented
  Object Notation](https://github.com/toon-format/toon)). Tabular arrays of
  uniform objects collapse to CSV-with-schema, which is roughly **40% fewer
  tokens** than JSON with comparable or better recall on LLM benchmarks.
- **`structuredContent`** (programmatic consumers) — always plain JSON-friendly
  objects. Downstream MCP tools that pipe results stay unchanged.

Knobs on read tools:

| Param      | Type                  | Effect                                                                |
|------------|-----------------------|-----------------------------------------------------------------------|
| `format`   | `"toon"` \| `"json"`  | Switch the text channel back to JSON if you need it. Default `"toon"`. |
| `verbose`  | `boolean`             | Skip the lean projection and return every field. Default `false`.     |
| `limit`    | `number` (1–500)      | Page size. List tools only.                                           |
| `offset`   | `number` (≥0)         | Page offset. Use `next_offset` from a prior response.                 |

Errors still come through as JSON in `text` — they're small and diagnostics
are easier when the format is universal.

## Quickstart

### 1. Get an API token

Log in to <https://adm.tools/user/api/> and create a token.

### 2. Add to your MCP client

#### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`
(macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "ukraine-com-ua": {
      "command": "bunx",
      "args": ["@rmarinsky/ukraine-com-ua-mcp"],
      "env": {
        "ADM_TOOLS_TOKEN": "your_token_here"
      }
    }
  }
}
```

If you don't have Bun installed, swap `bunx` for `npx`.

#### Claude Code

```bash
claude mcp add ukraine-com-ua \
  --env ADM_TOOLS_TOKEN=your_token_here \
  -- bunx @rmarinsky/ukraine-com-ua-mcp
```

#### Cursor

In `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "ukraine-com-ua": {
      "command": "bunx",
      "args": ["@rmarinsky/ukraine-com-ua-mcp"],
      "env": { "ADM_TOOLS_TOKEN": "your_token_here" }
    }
  }
}
```

### 3. Try it

In Claude:

> List my domains at ukraine.com.ua and show me the DNS records for `example.com.ua`.

Claude will call `list_domains`, find the matching `id`, then call
`list_dns_records` with that id.

## Local development

```bash
bun install
cp .env.example .env             # paste your token
bun run dev                      # MCP server in stdio mode (Ctrl-C to stop)
bun run cli list-domains         # standalone CLI
bun run cli check rmarinsky.com.ua
bun run cli call dns/list        # raw passthrough for any endpoint
bun run validate                 # typecheck + lint + tests
```

## Configuration (env vars)

| Variable                          | Required | Default                | Notes                                           |
|-----------------------------------|----------|------------------------|-------------------------------------------------|
| `ADM_TOOLS_TOKEN`                 | yes      | —                      | Bearer token from `https://adm.tools/user/api/` |
| `ADM_TOOLS_BASE_URL`              | no       | `https://adm.tools`    | Override for self-hosted proxies                |
| `ADM_TOOLS_TIMEOUT_MS`            | no       | `15000`                | Per-request timeout                             |
| `ADM_TOOLS_MAX_RETRIES`           | no       | `3`                    | Retries on 5xx and 429                          |
| `ADM_TOOLS_DOMAIN_CACHE_TTL_MS`   | no       | `3600000`              | `list_domains` in-memory cache TTL              |
| `ADM_TOOLS_LOG_FILE`              | no       | —                      | Append per-request log (token always redacted)  |
| `ADM_TOOLS_ENABLE_WRITE_TOOLS`    | no       | `true`                 | Set `false` to expose only read-only tools      |
| `ADM_TOOLS_BACKUP_DIR`            | no       | `./dns-backups`        | Where DNS zone snapshots are written            |
| `ADM_TOOLS_BACKUP_MAX_AGE_MS`     | no       | `600000`               | How long a `backup_id` is considered fresh (10m default) |
| `ADM_TOOLS_REQUIRE_BACKUP`        | no       | `true`                 | Set `false` to make `backup_id` optional on writes |

## Backup safety

Every DNS mutation (`create/update/delete_dns_record`) requires a fresh
`backup_id` from `backup_dns_zone`. The MCP refuses to mutate when:

1. No `backup_id` is provided (unless `ADM_TOOLS_REQUIRE_BACKUP=false`).
2. The backup file is older than `ADM_TOOLS_BACKUP_MAX_AGE_MS`.
3. The current zone hash no longer matches the `backup_id` — i.e. someone
   (or something) modified the zone between your snapshot and your write.

When something goes wrong, `restore_dns_zone(domain_id, backup_id, confirm: true)`
diffs the live zone against the backup and replays create/update/delete calls
to converge. Restore is **not atomic**: if a mid-replay call fails, the report
lists what succeeded and what didn't.

Detailed walkthrough (Ukrainian): [`docs/uk/backup.md`](docs/uk/backup.md).

## Gotchas

- **`subdomain_id` ≠ `domain_id`.** When updating or deleting a DNS record,
  pass the `id` field shown for that *record* (its "subdomain id"), **not** the
  parent domain's id. The naming is unfortunate but it's how the API works.
- **`@` for root, `*` for wildcard.** Same as standard zone files.
- **MX presets don't include SPF/DKIM/DMARC.** After `set_mx_preset` you'll
  almost always want to call `create_dns_record` three more times for those TXT
  records.
- **DNSSEC blocks NS changes.** Call `disable_dnssec` first, wait, then
  `change_nameservers`. The API returns a confusing error otherwise.
- **`.ua` registry constraints.** Custom NS hosts on `.ua` domains must be
  pre-registered in the `.ua` registry. Cloudflare / Hetzner / deSEC nameservers
  work without setup; arbitrary hostnames don't.
- **Balance ≠ free.** `register_domain` and `create_mailbox` cost money.
  Always call `get_balance` before triggering paid actions.

## Safety model

Every destructive tool requires `confirm: z.literal(true)`:

- `delete_dns_record` (changes are slow to roll back due to caches)
- `restore_dns_zone` (replay can fail mid-flight, leaving partial state)

In addition, all write tools require a fresh `backup_id` from `backup_dns_zone`
— see [Backup safety](#backup-safety) above. Together this catches both LLM
mistakes (wrong record id) and silent overwrites (zone changed concurrently).

The tool description for each destructive tool instructs Claude to confirm the
change with you in chat before sending `confirm: true`. You can also force
read-only mode by setting `ADM_TOOLS_ENABLE_WRITE_TOOLS=false`, which removes
destructive tools from the registered list entirely.

## Limitations

- **No public OpenAPI spec.** Endpoints are reverse-engineered from the
  [official PHP reference](https://github.com/ukraine-com-ua/API) and the
  [community PHP wrapper](https://github.com/kudinovfedor/ukraine-api).
  adm.tools may change response shapes without notice; report breakage via
  GitHub issues.
- **No rate limit documentation.** The client retries 5xx and 429 with
  exponential backoff, but there's no published rate-limit budget.
- **No webhooks.** All polling. Build your own watcher if you need that.
- **No Terraform provider.** For Terraform-driven DNS, delegate DNS to
  Cloudflare and use ukraine.com.ua only as registrar.
- **EPP not exposed.** This wraps the HTTP API only. Direct EPP access would
  need a different package.

## Out of scope

- Browser automation / scraping the adm.tools web UI.
- Database CRUD (too easy to nuke production from chat).
- FTP user management (niche).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The short version:

1. Add the client method in `src/admtools.ts` plus types in `src/types.ts`.
2. Register the tool in `src/server.ts` (and optionally a `src/cli.ts` command).
3. Add a unit test in `test/admtools.test.ts` that asserts the form-encoded
   body and URL.
4. Update `docs/api-endpoints.md` to flip the row from `⬜` to `✅`.
5. `bun run validate` must pass before opening a PR.

## License

MIT — see [LICENSE](LICENSE).
