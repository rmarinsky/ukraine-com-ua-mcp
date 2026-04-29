#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import pkg from "../package.json" with { type: "json" };
import { AdmToolsClient } from "./admtools.js";
import { BackupStore } from "./backup-store.js";
import { TtlCache } from "./cache.js";
import { type Config, ConfigError, loadConfig } from "./config.js";
import { AdmToolsAuthError, AdmToolsError, BackupError } from "./errors.js";
import { type LlmFormat, type ProjectionConfig, applyProjection, encodeForLlm } from "./llm-encode.js";
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT, paginate } from "./paginate.js";
import { DNS_RECORD_LIST_LEAN, DOMAIN_LIST_LEAN } from "./projections.js";
import { DNS_RECORD_TYPES, type DnsRecord, type DnsRecordType } from "./types.js";

const PACKAGE_NAME = "ukraine-com-ua-mcp";
const PACKAGE_VERSION = pkg.version;

interface OkOptions {
	format?: LlmFormat;
}

/**
 * MCP result builder. The `text` channel uses TOON by default (compact for
 * LLM consumption); the `structuredContent` channel keeps the same shape as
 * a plain JS object so programmatic downstream consumers stay happy.
 *
 * Projections are applied by the caller before passing to `ok` — they only
 * make sense at specific positions in the response wrapper (the items array
 * of a list, or the data object of an info endpoint). Doing it here would
 * accidentally strip metadata fields like `total`, `has_more`, etc.
 */
function ok(data: unknown, opts: OkOptions = {}) {
	const payload = data && typeof data === "object" ? (data as Record<string, unknown>) : { value: data };
	return {
		content: [{ type: "text" as const, text: encodeForLlm(payload, { format: opts.format }) }],
		structuredContent: payload,
	};
}

/** Apply projection unless verbose mode is on. */
function project<T>(value: T, projection: ProjectionConfig, verbose: boolean | undefined): T {
	return verbose ? value : (applyProjection(value, projection) as T);
}

function fail(error: unknown) {
	const message = error instanceof Error ? error.message : String(error);
	const detail: Record<string, unknown> = { error: message };
	if (error instanceof AdmToolsError) {
		detail.action = error.action;
		detail.status = error.status;
		detail.apiError = error.apiError;
		detail.kind = error instanceof AdmToolsAuthError ? "auth" : "api";
	}
	if (error instanceof BackupError) {
		detail.kind = "backup";
		if (error.hint) detail.hint = error.hint;
	}
	// Errors are small and JSON is universal for diagnostics — keep them as JSON.
	return {
		isError: true,
		content: [{ type: "text" as const, text: JSON.stringify(detail, null, 2) }],
		structuredContent: detail,
	};
}

async function safeHandle(fn: () => Promise<unknown>, opts: OkOptions = {}) {
	try {
		return ok(await fn(), opts);
	} catch (e) {
		return fail(e);
	}
}

function asUnknownArray(v: unknown): unknown[] {
	return Array.isArray(v) ? v : [];
}

function requireConfirm(confirm: unknown, action: string) {
	if (confirm !== true) return fail(new Error(`confirm must be true to ${action}`));
	return null;
}

const domainIdSchema = z.union([z.number(), z.string()]).describe("Domain id from list_domains.");
const formatSchema = z
	.enum(["toon", "json"])
	.optional()
	.describe(
		"Output format for the text channel. 'toon' (default) is ~40% fewer tokens than JSON; pass 'json' if you need standard JSON.",
	);
const verboseSchema = z
	.boolean()
	.optional()
	.describe("Return all fields (default false → lean projection with the most useful fields only).");
const limitSchema = z
	.number()
	.int()
	.min(1)
	.max(MAX_PAGE_LIMIT)
	.optional()
	.describe(`Page size (1–${MAX_PAGE_LIMIT}, default ${DEFAULT_PAGE_LIMIT}).`);
const offsetSchema = z
	.number()
	.int()
	.min(0)
	.optional()
	.describe("Page offset (default 0). Use `next_offset` from a prior response to paginate.");

export function buildServer(config: Config): McpServer {
	const client = new AdmToolsClient({
		token: config.token,
		baseUrl: config.baseUrl,
		timeoutMs: config.timeoutMs,
		maxRetries: config.maxRetries,
		logFile: config.logFile,
	});

	const domainCache = new TtlCache<unknown>(config.domainCacheTtlMs);
	const backupStore = new BackupStore({ dir: config.backupDir, maxAgeMs: config.backupMaxAgeMs });

	const server = new McpServer({ name: PACKAGE_NAME, version: PACKAGE_VERSION });

	/**
	 * Verify that `backupId` is fresh and reflects the current zone state.
	 * Resolves on success; throws `BackupError` on missing/expired/stale backup
	 * so the surrounding `safeHandle` turns it into a structured failure.
	 *
	 * Loads the backup file in parallel with the live records fetch, so the
	 * precondition costs ~one API round trip plus a tiny disk read.
	 *
	 * If `config.requireBackup` is `false` and `backupId` is empty, the check is
	 * skipped — this is the CI/automation escape hatch.
	 */
	async function requireFreshBackup(domainId: string | number, backupId: string | undefined): Promise<void> {
		if (!backupId) {
			if (!config.requireBackup) return;
			throw new BackupError(
				"backup_id is required. Run backup_dns_zone first.",
				"Call backup_dns_zone for this domain_id, then pass the returned backup_id here.",
			);
		}
		const [backupFile, current] = await Promise.all([
			backupStore.load(domainId, backupId),
			client.listDnsRecords(domainId),
		]);
		if (backupStore.isExpired({ savedAt: backupFile.saved_at })) {
			throw new BackupError(
				`Backup expired (older than ${config.backupMaxAgeMs}ms). Re-run backup_dns_zone.`,
				"Take a fresh snapshot via backup_dns_zone and use the new backup_id.",
			);
		}
		if (!backupStore.verifyMatches(backupId, current)) {
			throw new BackupError(
				"Zone changed since backup_id was issued. Mutation refused.",
				"Run backup_dns_zone again — someone else (or another tool) changed this zone.",
			);
		}
	}

	// ----------------------------------------------------------------------
	// Tier 1 — Domain discovery and management
	// ----------------------------------------------------------------------

	server.registerTool(
		"check_domain_availability",
		{
			title: "Check domain availability",
			description:
				"Check whether a domain is free to register at ukraine.com.ua (adm.tools). Read-only. " +
				"Use BEFORE register_domain. Output is TOON; pass `format: 'json'` for JSON.",
			inputSchema: {
				domain: z.string().min(3).describe("Fully-qualified domain to check, e.g. 'rmarinsky.com.ua'"),
				format: formatSchema,
			},
		},
		async ({ domain, format }) =>
			safeHandle(async () => ({ domain, data: await client.checkDomainAvailability(domain) }), { format }),
	);

	server.registerTool(
		"list_domains",
		{
			title: "List domains",
			description: `List domains in the adm.tools account. Output is TOON with a lean projection by default — pass \`verbose: true\` for the full payload, \`format: 'json'\` for JSON syntax. Paginated: default page size ${DEFAULT_PAGE_LIMIT}, max ${MAX_PAGE_LIMIT}. The returned \`id\` is the \`domain_id\` used by other tools. Cached in-process for the configured TTL.`,
			inputSchema: {
				refresh: z.boolean().optional().describe("If true, bypass the in-memory cache and refetch."),
				limit: limitSchema,
				offset: offsetSchema,
				verbose: verboseSchema,
				format: formatSchema,
			},
		},
		async ({ refresh, limit, offset, verbose, format }) =>
			safeHandle(
				async () => {
					let domains = !refresh ? (domainCache.get("domains") as unknown[] | undefined) : undefined;
					const cached = domains !== undefined;
					if (!cached) {
						domains = await client.listDomains();
						domainCache.set("domains", domains);
					}
					const page = paginate(asUnknownArray(domains), { limit, offset });
					return {
						cached,
						total: page.total,
						limit: page.limit,
						offset: page.offset,
						has_more: page.has_more,
						next_offset: page.next_offset,
						domains: project(page.items, DOMAIN_LIST_LEAN, verbose),
					};
				},
				{ format },
			),
	);

	// ----------------------------------------------------------------------
	// DNS records
	// ----------------------------------------------------------------------

	server.registerTool(
		"list_dns_records",
		{
			title: "List DNS records",
			description:
				"List DNS records for a domain. Each record's `id` is the `subdomain_id` for " +
				"update_dns_record / delete_dns_record. `record` = '@' is the zone root, '*' is a " +
				"wildcard. Output is TOON with a lean projection by default — pass `verbose: true` for " +
				"full data, `format: 'json'` for JSON syntax. Paginated and filterable by record type.",
			inputSchema: {
				domain_id: domainIdSchema,
				type: z.enum(DNS_RECORD_TYPES).optional().describe("Filter by record type (A, MX, TXT, ...)."),
				limit: limitSchema,
				offset: offsetSchema,
				verbose: verboseSchema,
				format: formatSchema,
			},
		},
		async ({ domain_id, type, limit, offset, verbose, format }) =>
			safeHandle(
				async () => {
					const all = await client.listDnsRecords(domain_id);
					const filtered = type ? all.filter((r) => String(r.type).toUpperCase() === type) : all;
					const page = paginate(filtered, { limit, offset });
					return {
						domain_id,
						type_filter: type ?? null,
						total: page.total,
						limit: page.limit,
						offset: page.offset,
						has_more: page.has_more,
						next_offset: page.next_offset,
						records: project(page.items, DNS_RECORD_LIST_LEAN, verbose),
					};
				},
				{ format },
			),
	);

	if (config.enableWriteTools) {
		const subdomainIdSchema = z
			.union([z.number(), z.string()])
			.describe("Record id from list_dns_records (field `id` on each record).");
		const backupIdSchema = config.requireBackup
			? z
					.string()
					.min(1)
					.describe(
						"SHA256 backup_id from backup_dns_zone. Mutation is refused if the backup is missing, " +
							"expired, or no longer matches the current zone state.",
					)
			: z
					.string()
					.min(1)
					.optional()
					.describe(
						"Optional SHA256 backup_id from backup_dns_zone. ADM_TOOLS_REQUIRE_BACKUP=false in this " +
							"deployment, so verification is skipped if omitted.",
					);

		server.registerTool(
			"backup_dns_zone",
			{
				title: "Backup DNS zone",
				description:
					"Snapshot a DNS zone to disk and return a `backup_id` (SHA256 of canonicalized records). " +
					"Pass that `backup_id` to subsequent create/update/delete_dns_record calls — they refuse " +
					"to mutate unless the backup is fresh and the live zone still matches the snapshot. " +
					"Read-only on adm.tools (just calls dns/records_list); writes a JSON file to ADM_TOOLS_BACKUP_DIR.",
				inputSchema: {
					domain_id: domainIdSchema,
					format: formatSchema,
				},
			},
			async ({ domain_id, format }) =>
				safeHandle(
					async () => {
						const records = await client.listDnsRecords(domain_id);
						const meta = await backupStore.save(domain_id, records);
						return {
							domain_id: meta.domainId,
							backup_id: meta.backupId,
							path: meta.path,
							record_count: meta.recordCount,
							saved_at: meta.savedAt,
							expires_at: meta.expiresAt,
						};
					},
					{ format },
				),
		);

		server.registerTool(
			"create_dns_record",
			{
				title: "Create DNS record",
				description:
					"Create a DNS record. For root use record='@'; for wildcard use record='*'. " +
					"`priority` is required for MX and ignored for other types. `data` content rules: " +
					"A=IPv4, AAAA=IPv6, CNAME/MX/NS/ALIAS=hostname, TXT=quoted string, SRV='prio weight port target'. " +
					"Requires a fresh `backup_id` from backup_dns_zone (set ADM_TOOLS_REQUIRE_BACKUP=false to disable).",
				inputSchema: {
					domain_id: domainIdSchema,
					type: z.enum(DNS_RECORD_TYPES).describe("Record type."),
					record: z.string().min(1).describe("Subdomain name. '@' = root, '*' = wildcard."),
					data: z.string().min(1).describe("Record value (IP, hostname, TXT body, etc.)"),
					priority: z
						.number()
						.int()
						.min(0)
						.max(65535)
						.optional()
						.describe("Priority for MX records (0–65535). Ignored for other types."),
					backup_id: backupIdSchema,
				},
			},
			async ({ domain_id, type, record, data, priority, backup_id }) =>
				safeHandle(async () => {
					await requireFreshBackup(domain_id, backup_id);
					return {
						domain_id,
						type,
						record,
						data,
						priority,
						response: await client.createDnsRecord({ domainId: domain_id, type, record, data, priority }),
					};
				}),
		);

		server.registerTool(
			"update_dns_record",
			{
				title: "Update DNS record",
				description:
					"Update an existing DNS record. `subdomain_id` is the record id from list_dns_records; " +
					"`domain_id` is required for backup verification. Pass the full new record state — " +
					"adm.tools replaces the record, it doesn't merge. " +
					"Requires a fresh `backup_id` from backup_dns_zone (set ADM_TOOLS_REQUIRE_BACKUP=false to disable).",
				inputSchema: {
					domain_id: domainIdSchema,
					subdomain_id: subdomainIdSchema,
					type: z.enum(DNS_RECORD_TYPES).describe("Record type."),
					record: z.string().min(1).describe("Subdomain name. '@' = root, '*' = wildcard."),
					data: z.string().min(1).describe("New record value."),
					priority: z.number().int().min(0).max(65535).optional().describe("MX priority."),
					backup_id: backupIdSchema,
				},
			},
			async ({ domain_id, subdomain_id, type, record, data, priority, backup_id }) =>
				safeHandle(async () => {
					await requireFreshBackup(domain_id, backup_id);
					return {
						domain_id,
						subdomain_id,
						type,
						record,
						data,
						priority,
						response: await client.updateDnsRecord({
							subdomainId: subdomain_id,
							type,
							record,
							data,
							priority,
						}),
					};
				}),
		);

		server.registerTool(
			"delete_dns_record",
			{
				title: "Delete DNS record (DESTRUCTIVE)",
				description:
					"Delete a DNS record by `subdomain_id`. `domain_id` is required for backup verification. " +
					"DESTRUCTIVE. Workflow: backup_dns_zone → list_dns_records → confirm with the human → " +
					"call this with confirm: true and the backup_id. Deletions take effect immediately and " +
					"DNS caches make rollback slow — restore_dns_zone can replay from backup if needed.",
				inputSchema: {
					domain_id: domainIdSchema,
					subdomain_id: subdomainIdSchema,
					confirm: z.literal(true).describe("Must be exactly true to delete."),
					backup_id: backupIdSchema,
				},
			},
			async ({ domain_id, subdomain_id, confirm, backup_id }) =>
				requireConfirm(confirm, "delete a DNS record") ??
				safeHandle(async () => {
					await requireFreshBackup(domain_id, backup_id);
					return {
						domain_id,
						subdomain_id,
						deleted: true,
						response: await client.deleteDnsRecord({ subdomainId: subdomain_id }),
					};
				}),
		);

		server.registerTool(
			"restore_dns_zone",
			{
				title: "Restore DNS zone from backup (DESTRUCTIVE)",
				description:
					"Replay a backup taken via backup_dns_zone: diff vs. the current zone, then create/update/delete " +
					"records to match the snapshot. DESTRUCTIVE. Restore is NOT atomic — if a mid-replay call " +
					"fails, the zone is left in a partial state and the report lists what succeeded and what didn't. " +
					"Records re-created from a backup get NEW subdomain ids (the originals are gone upstream).",
				inputSchema: {
					domain_id: domainIdSchema,
					backup_id: z.string().min(1).describe("backup_id returned by backup_dns_zone for this domain."),
					confirm: z.literal(true).describe("Must be exactly true to run the restore."),
					format: formatSchema,
				},
			},
			async ({ domain_id, backup_id, confirm, format }) =>
				requireConfirm(confirm, "restore a DNS zone from backup") ??
				safeHandle(
					async () => {
						const [backupFile, current] = await Promise.all([
							backupStore.load(domain_id, backup_id),
							client.listDnsRecords(domain_id),
						]);
						return await restoreFromBackup(client, domain_id, backupFile.records, current);
					},
					{ format },
				),
		);
	}

	// ----------------------------------------------------------------------
	// Billing
	// ----------------------------------------------------------------------

	server.registerTool(
		"get_balance",
		{
			title: "Get account balance",
			description:
				"Fetch the current account balance. Read-only. Recommend calling this before any paid " +
				"action (register_domain, etc.). Output is TOON; pass `format: 'json'` for JSON.",
			inputSchema: { format: formatSchema },
		},
		async ({ format }) => safeHandle(async () => ({ data: await client.getBalance() }), { format }),
	);

	return server;
}

interface RestoreReport {
	domain_id: string | number;
	created: number;
	updated: number;
	deleted: number;
	unchanged: number;
	errors: Array<{ id: string | number; action: string; message: string }>;
}

/**
 * Replay a backup against the current zone. Uses `id` as the join key:
 * - in backup, missing in current → recreate (new subdomain id, the old one is gone)
 * - in current, missing in backup → delete
 * - in both with field diffs (type/record/data/priority) → update
 * - in both with no diffs → no-op
 *
 * Errors are captured per-record rather than thrown so the user always sees a
 * full report — partial state is the failure mode here.
 */
async function restoreFromBackup(
	client: AdmToolsClient,
	domainId: string | number,
	backupRecords: readonly DnsRecord[],
	currentRecords: readonly DnsRecord[],
): Promise<RestoreReport> {
	const report: RestoreReport = {
		domain_id: domainId,
		created: 0,
		updated: 0,
		deleted: 0,
		unchanged: 0,
		errors: [],
	};
	const byId = (records: readonly DnsRecord[]) => new Map(records.map((r) => [String(r.id), r]));
	const backupById = byId(backupRecords);
	const currentById = byId(currentRecords);

	for (const [id, rec] of currentById) {
		if (backupById.has(id)) continue;
		try {
			await client.deleteDnsRecord({ subdomainId: rec.id });
			report.deleted += 1;
		} catch (err) {
			report.errors.push({ id: rec.id, action: "delete", message: errorMessage(err) });
		}
	}

	for (const [id, backupRec] of backupById) {
		const currentRec = currentById.get(id);
		if (!currentRec) {
			try {
				await client.createDnsRecord({
					domainId,
					type: backupRec.type as DnsRecordType,
					record: backupRec.record,
					data: backupRec.data,
					priority: backupRec.priority,
				});
				report.created += 1;
			} catch (err) {
				report.errors.push({ id: backupRec.id, action: "create", message: errorMessage(err) });
			}
			continue;
		}
		if (
			currentRec.type === backupRec.type &&
			currentRec.record === backupRec.record &&
			currentRec.data === backupRec.data &&
			currentRec.priority === backupRec.priority
		) {
			report.unchanged += 1;
			continue;
		}
		try {
			await client.updateDnsRecord({
				subdomainId: currentRec.id,
				type: backupRec.type as DnsRecordType,
				record: backupRec.record,
				data: backupRec.data,
				priority: backupRec.priority,
			});
			report.updated += 1;
		} catch (err) {
			report.errors.push({ id: currentRec.id, action: "update", message: errorMessage(err) });
		}
	}

	return report;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

async function main() {
	let config: Config;
	try {
		config = loadConfig();
	} catch (err) {
		if (err instanceof ConfigError) {
			console.error(`[${PACKAGE_NAME}] config error: ${err.message}`);
			process.exit(2);
		}
		throw err;
	}

	const server = buildServer(config);
	const transport = new StdioServerTransport();
	await server.connect(transport);
}

const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
	main().catch((err) => {
		console.error(`[${PACKAGE_NAME}] fatal:`, err);
		process.exit(1);
	});
}
