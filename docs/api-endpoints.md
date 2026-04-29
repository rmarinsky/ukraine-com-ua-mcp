# adm.tools API endpoint reference

Community reference for the **ukraine.com.ua / adm.tools** HTTP API. There is
**no official OpenAPI spec**, no public changelog, and several endpoints
documented in older PHP references have been removed upstream without notice.
Field names and live status below were verified against the production API on
**2026-04-29**.

## Conventions

- **Base URL**: `https://adm.tools/action/{action}/`
- **Method**: `POST`
- **Body**: `application/x-www-form-urlencoded`
- **Auth**: header `Authorization: Bearer <token>` from `https://adm.tools/user/api/`
- **Response (success)**: `{ result: true, response: <object|array> }`
- **Response (error)**: `{ result: false, error: { code?, message? } }` or `{ result: false, messages: { error: [...] } }`
- **Localization**: none. Errors come back hardcoded in Ukrainian/Russian. `Accept-Language`, `lang=`, `locale=` parameters all have no effect.

## Request encoding

Two field-name conventions appear consistently:

- **`domain_id`** scopes a request to a specific domain. Used by every
  endpoint that operates on one zone.
- **`subdomain_id`** scopes a request to a specific DNS record inside a zone.
  Used by `dns/record_edit` and `dns/record_delete`. (The naming is confusing
  — it's a record id, not a subdomain id in the DNS sense.)

Older PHP references called the first case `id`. **Production adm.tools
rejects `id` with HTTP 422** «Відсутнє значення параметра _POST[domain_id]».
Always send `domain_id`. The mapping is centralized in
[`src/admtools.ts`](../src/admtools.ts) via the `DOMAIN_ID_FIELD` and
`SUBDOMAIN_ID_FIELD` constants — refactor through there.

## Status legend

- ✅ wrapped — exposed both in `AdmToolsClient` and as an MCP tool
- 🟡 client-only — `AdmToolsClient.call(...)` works but no typed wrapper
- ⬜ documented but not wrapped — endpoint may exist; PR welcome (verify live first)
- 💀 dead — endpoint removed upstream and now returns HTTP 400 «site/X handler not found»

## Verified-live endpoints

| Action                                  | Status | Form fields                                                  | Notes                                       |
|-----------------------------------------|:------:|--------------------------------------------------------------|---------------------------------------------|
| `domain/check`                          |   ✅   | `domain`                                                     | Is a domain free to register, with price    |
| `dns/list`                              |   ✅   | (none)                                                       | All domains in the account                  |
| `dns/records_list`                      |   ✅   | `domain_id`                                                  | All DNS records for a zone                  |
| `dns/record_add`                        |   ✅   | `domain_id`, `type`, `record`, `data`, `priority?`           | Use `@` for root, `*` for wildcard          |
| `dns/record_edit`                       |   ✅   | `subdomain_id`, `type`, `record`, `data`, `priority?`        | `subdomain_id` = record id (not domain id)  |
| `dns/record_delete`                     |   ✅   | `subdomain_id`                                               | Destructive                                 |
| `billing/balance_get`                   |   ✅   | (none)                                                       | Current account balance                     |
| `mail/list`                             |   🟡   | `domain_id?`                                                 | Returns `[]` for accounts with no mailboxes; semantics not fully verified |

## Endpoints removed upstream (do not call)

These were documented in older PHP references but adm.tools has since
removed them. All return HTTP 400 «Не найден обработчик события site/X».
None of them is wrapped in this MCP — included here so contributors don't
re-add them without finding a replacement first.

| Action                                  | Status | Replacement                                          |
|-----------------------------------------|:------:|------------------------------------------------------|
| `dns/domain_check`                      |   💀   | `domain/check`                                        |
| `dns/domain_info`                       |   💀   | `dns/list` (data is in each row)                      |
| `dns/domain_create`                     |   💀   | None known. Register via the web UI.                  |
| `dns/ns_info`                           |   💀   | `dns/records_list` filtered to `type=NS`              |
| `dns/ns_edit`                           |   💀   | None known. Change NS via the web UI.                 |
| `dns/dnssec_enable`                     |   💀   | None known.                                           |
| `dns/dnssec_disable`                    |   💀   | None known.                                           |
| `dns/record_mx_predefined`              |   💀   | Apply MX records via `dns/record_add` manually.       |
| `account/info`                          |   💀   | None known.                                           |
| `mailbox/info`                          |   💀   | `mail/list` (semantics differ — investigate)          |
| `mailbox/create`                        |   💀   | None known. Create via the web UI.                    |
| `config/ssl/crt/lets_encrypt`           |   💀   | None known. Issue SSL via the web UI.                 |

## Generic passthrough

The client method `AdmToolsClient.call(action, params)` works for any action.
Useful for probing live status:

```bash
ADM_TOOLS_TOKEN=… bun run src/cli.ts call mail/list domain_id=12345
ADM_TOOLS_TOKEN=… bun run src/cli.ts call domain/check domain=example.com.ua
```

If you find a working endpoint that's not in the table above, please open an
issue or PR.

## Adding support for a new endpoint

1. **Probe live first** — `bun run src/cli.ts call <action> <params>` and
   confirm it returns a sensible payload. Don't assume any older docs are
   accurate.
2. Add a typed method in `src/admtools.ts`. Use `DOMAIN_ID_FIELD` /
   `SUBDOMAIN_ID_FIELD` for id parameters.
3. Register the MCP tool in `src/server.ts`. Mark destructive ones with
   `confirm: z.literal(true)` and a clear chat-confirmation instruction in
   the description.
4. Add a unit test asserting URL + form body in `test/admtools.test.ts`.
5. Add the row to "Verified-live endpoints" with status ✅.
6. Run `bun run validate` — all checks must be green before opening a PR.
