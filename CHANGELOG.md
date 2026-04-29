# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`backup_dns_zone` tool** — snapshot a DNS zone to disk and return a SHA256
  `backup_id` (hash of canonicalized records). Required precondition for every
  write tool.
- **`restore_dns_zone` tool** — diff a backup against the live zone and
  replay create/update/delete to converge. Destructive (`confirm: true`),
  not atomic.
- **Mandatory `backup_id` parameter** on `create_dns_record`,
  `update_dns_record`, `delete_dns_record`. Mutation is refused if the backup
  is missing, expired, or no longer matches the live zone.
- **`domain_id` parameter** added to `update_dns_record` and `delete_dns_record`
  (previously only `subdomain_id`). Required for backup verification.
- **Env vars:** `ADM_TOOLS_BACKUP_DIR` (default `./dns-backups`),
  `ADM_TOOLS_BACKUP_MAX_AGE_MS` (default `600000` = 10 min),
  `ADM_TOOLS_REQUIRE_BACKUP` (default `true`).
- **Ukrainian documentation:** [`README.uk.md`](README.uk.md) (full
  translation) and [`docs/uk/backup.md`](docs/uk/backup.md) (backup workflow,
  troubleshooting, env vars).
- **`BackupError`** exception class in `src/errors.ts` with optional `hint`
  field for human-readable next steps.
- **`BackupStore`** module (`src/backup-store.ts`) — filesystem-backed,
  hash-stamped snapshots with deterministic SHA256 over canonicalized records.

## [0.1.0] — 2026-04-29

Initial public release. Tool surface narrowed to endpoints verified live
against production adm.tools on 2026-04-29 (see
[`docs/api-endpoints.md`](docs/api-endpoints.md) for the full list and the
graveyard of dead upstream endpoints).

### MCP tools

Read:
- `check_domain_availability` (`domain/check`)
- `list_domains` (`dns/list`) — paginated, lean projection by default
- `list_dns_records` (`dns/records_list`) — paginated, type-filterable, lean projection by default
- `get_balance` (`billing/balance_get`)

Write (require `confirm: true` for destructive ops):
- `create_dns_record` (`dns/record_add`)
- `update_dns_record` (`dns/record_edit`)
- `delete_dns_record` (`dns/record_delete`)

### Output format

- TOON ([Token-Oriented Object Notation](https://github.com/toon-format/toon))
  on the `text` channel by default — about 40% fewer tokens than JSON for
  list responses, with comparable or better LLM comprehension on benchmarks.
- `structuredContent` stays JSON so programmatic downstream consumers are
  unaffected.
- `format: "toon" | "json"` parameter on read tools as an escape hatch.
- `verbose: true` parameter on list tools to bypass the lean projection and
  return every field.
- `limit` / `offset` for pagination on list tools (default 50, max 500).
- Real-account measurement: `list_domains` payload dropped from 6789 bytes
  (full JSON) to 341 bytes (lean TOON) — a 95% reduction.

### Client (`AdmToolsClient`)

- Bearer-auth POST with form-encoded body.
- Exponential-backoff retry on 5xx, 429, and network/timeout failures.
- 15-second per-attempt timeout via `AbortController`.
- Injectable `fetchImpl` for tests.
- Optional request log file (`ADM_TOOLS_LOG_FILE`) — token always redacted,
  appends are fire-and-forget so they never block the response path.
- Centralised form-field convention (`DOMAIN_ID_FIELD`, `SUBDOMAIN_ID_FIELD`)
  — adm.tools wants `domain_id` (not `id`) on every domain-scoped endpoint;
  `subdomain_id` for record-scoped endpoints.

### Documentation

- Per-endpoint reference at [`docs/api-endpoints.md`](docs/api-endpoints.md)
  with live/dead status verified against production.
- README quickstart for Claude Desktop, Claude Code, Cursor.
- Issue templates for bug reports and new-endpoint requests.

[Unreleased]: https://github.com/rmarinsky/ukraine-com-ua-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/rmarinsky/ukraine-com-ua-mcp/releases/tag/v0.1.0
