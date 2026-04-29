import { appendFile } from "node:fs/promises";
import { AdmToolsAuthError, AdmToolsError } from "./errors.js";
import type {
	AdmToolsApiErrorBody,
	AdmToolsEnvelope,
	DnsRecord,
	DnsRecordType,
	DomainListItem,
} from "./types.js";

export type FetchImpl = typeof fetch;

export interface AdmToolsClientOptions {
	token: string;
	baseUrl?: string;
	timeoutMs?: number;
	maxRetries?: number;
	fetchImpl?: FetchImpl;
	logFile?: string;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}

export interface RequestParams {
	[key: string]: string | number | boolean | undefined;
}

const DEFAULT_BASE_URL = "https://adm.tools";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 3;
const TOKEN_REDACTION = "[REDACTED]";

/**
 * adm.tools wants a `domain_id` form field on every endpoint that scopes to a
 * specific domain. The 0.x docs (and earlier internal docs) called it `id`,
 * which the production API rejects with HTTP 422 «Відсутнє значення параметра
 * _POST[domain_id]». DO NOT change this without re-probing the live API.
 *
 * Endpoints that scope to a *record* use `subdomain_id` instead — see
 * SUBDOMAIN_ID_FIELD.
 */
const DOMAIN_ID_FIELD = "domain_id";
const SUBDOMAIN_ID_FIELD = "subdomain_id";

/**
 * Low-level client for the adm.tools (ukraine.com.ua) HTTP API.
 *
 * Conventions:
 *  - All endpoints accept `application/x-www-form-urlencoded` POST bodies.
 *  - Authorization is `Bearer <token>` from https://adm.tools/user/api/.
 *  - Successful responses: `{ result: true, response: ... }`.
 *  - Error responses:      `{ result: false, error: { code?, message? } }`.
 *
 * Retry policy: exponential backoff for HTTP 5xx and 429, capped at
 * `maxRetries`. 4xx (other than 429) is not retried — the request is
 * malformed or unauthorized. Network errors and timeouts are also retried.
 */
export class AdmToolsClient {
	private readonly token: string;
	private readonly baseUrl: string;
	private readonly timeoutMs: number;
	private readonly maxRetries: number;
	private readonly fetchImpl: FetchImpl;
	private readonly logFile?: string;
	private readonly now: () => number;
	private readonly sleep: (ms: number) => Promise<void>;
	private pendingLog: Promise<void> = Promise.resolve();

	constructor(opts: AdmToolsClientOptions) {
		if (!opts.token || opts.token.trim() === "") {
			throw new Error("AdmToolsClient: token is required");
		}
		this.token = opts.token.trim();
		this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
		this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
		this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
		this.logFile = opts.logFile;
		this.now = opts.now ?? Date.now;
		this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
	}

	// ----------------------------------------------------------------------
	// Domain discovery
	// ----------------------------------------------------------------------

	/**
	 * `domain/check` — is a domain available to register and at what price.
	 * Action path is `domain/check`, not the older `dns/domain_check` (which
	 * was removed upstream). Verified against production 2026-04-29.
	 */
	async checkDomainAvailability(domain: string): Promise<unknown> {
		return this.call("domain/check", { domain });
	}

	/** `dns/list` — all domains in the account. */
	async listDomains(): Promise<DomainListItem[]> {
		const data = await this.call<unknown>("dns/list", {});
		return normalizeDomainList(data);
	}

	// ----------------------------------------------------------------------
	// DNS records
	// ----------------------------------------------------------------------

	/** `dns/records_list` — all records for a domain. */
	async listDnsRecords(domainId: number | string): Promise<DnsRecord[]> {
		const data = await this.call<unknown>("dns/records_list", { [DOMAIN_ID_FIELD]: domainId });
		return normalizeDnsRecords(data);
	}

	/** `dns/record_add` — create a DNS record. Use `@` for root, `*` for wildcard. */
	async createDnsRecord(input: {
		domainId: number | string;
		type: DnsRecordType;
		record: string;
		data: string;
		priority?: number;
	}): Promise<unknown> {
		return this.call("dns/record_add", {
			[DOMAIN_ID_FIELD]: input.domainId,
			type: input.type,
			record: input.record,
			data: input.data,
			...(input.priority !== undefined ? { priority: input.priority } : {}),
		});
	}

	/** `dns/record_edit` — modify by `subdomain_id` (NOT `domain_id`). */
	async updateDnsRecord(input: {
		subdomainId: number | string;
		type: DnsRecordType;
		record: string;
		data: string;
		priority?: number;
	}): Promise<unknown> {
		return this.call("dns/record_edit", {
			[SUBDOMAIN_ID_FIELD]: input.subdomainId,
			type: input.type,
			record: input.record,
			data: input.data,
			...(input.priority !== undefined ? { priority: input.priority } : {}),
		});
	}

	/** `dns/record_delete` — destructive. */
	async deleteDnsRecord(input: { subdomainId: number | string }): Promise<unknown> {
		return this.call("dns/record_delete", { [SUBDOMAIN_ID_FIELD]: input.subdomainId });
	}

	// ----------------------------------------------------------------------
	// Billing
	// ----------------------------------------------------------------------

	/** `billing/balance_get` — current balance. */
	async getBalance(): Promise<unknown> {
		return this.call("billing/balance_get", {});
	}

	// ----------------------------------------------------------------------
	// Generic call/transport
	// ----------------------------------------------------------------------

	/**
	 * Invoke any adm.tools action. Public so power users can wrap endpoints
	 * we don't model yet without forking the package.
	 */
	async call<T = unknown>(action: string, params: RequestParams = {}): Promise<T> {
		const url = `${this.baseUrl}/action/${action}/`;
		const body = encodeForm(params);

		let attempt = 0;
		// `attempt` is the current try (1-based once incremented); maxRetries is the number
		// of *additional* attempts after the first, so total tries = maxRetries + 1.
		// Bounded loop: every iteration either returns/throws or hits `continue`, and the
		// `attempt > maxRetries` guards inside guarantee termination.
		for (;;) {
			attempt += 1;
			const startedAt = this.now();
			try {
				const response = await this.fetchWithTimeout(url, body);
				const text = await response.text();
				const elapsedMs = this.now() - startedAt;
				// Log fire-and-forget: chained on pendingLog so writes stay ordered, but
				// the response path never blocks on disk I/O.
				this.logSafe({ action, status: response.status, elapsedMs, attempt });

				if (response.status === 401 || response.status === 403) {
					throw new AdmToolsAuthError(
						`adm.tools rejected the API token (HTTP ${response.status}). Get a new one from https://adm.tools/user/api/.`,
						{ status: response.status, action, apiError: safeJson(text) },
					);
				}

				if (response.status >= 500 || response.status === 429) {
					// retryable
					if (attempt > this.maxRetries) {
						throw new AdmToolsError(
							`adm.tools ${action} failed after ${attempt} attempts (HTTP ${response.status})`,
							{ status: response.status, action, apiError: safeJson(text) },
						);
					}
					await this.sleep(backoffDelayMs(attempt));
					continue;
				}

				if (response.status >= 400) {
					throw new AdmToolsError(`adm.tools ${action} failed (HTTP ${response.status})`, {
						status: response.status,
						action,
						apiError: safeJson(text),
					});
				}

				const json = parseEnvelope<T>(text, action, response.status);
				if (json.result === false) {
					const apiError = json.error ?? {};
					throw mapApiError(action, response.status, apiError);
				}
				return (json.response ?? ({} as T)) as T;
			} catch (err) {
				if (err instanceof AdmToolsAuthError) throw err;
				if (err instanceof AdmToolsError) throw err;

				// Network-level / timeout / abort: retryable.
				if (attempt > this.maxRetries) {
					throw new AdmToolsError(
						`adm.tools ${action} failed after ${attempt} attempts: ${(err as Error).message ?? String(err)}`,
						{ status: 0, action, cause: err },
					);
				}
				await this.sleep(backoffDelayMs(attempt));
			}
		}
	}

	private async fetchWithTimeout(url: string, body: string): Promise<Response> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		try {
			return await this.fetchImpl(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					Authorization: `Bearer ${this.token}`,
					Accept: "application/json",
				},
				body,
				signal: controller.signal,
			});
		} finally {
			clearTimeout(timer);
		}
	}

	private logSafe(entry: { action: string; status: number; elapsedMs: number; attempt: number }): void {
		if (!this.logFile) return;
		const line = `${new Date(this.now()).toISOString()} ${entry.action} status=${entry.status} attempt=${entry.attempt} elapsed_ms=${entry.elapsedMs} token=${TOKEN_REDACTION}\n`;
		const file = this.logFile;
		// Chain so writes stay ordered; swallow errors so a bad log file never
		// poisons subsequent writes or the call path.
		this.pendingLog = this.pendingLog.then(() => appendFile(file, line).catch(() => {}));
	}

	/** Wait for pending log writes. For graceful shutdown and tests. */
	async flushLogs(): Promise<void> {
		await this.pendingLog;
	}
}

// --------------------------------------------------------------------------
// Helpers (pure, exported for tests)
// --------------------------------------------------------------------------

export function encodeForm(params: RequestParams): string {
	const sp = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (value === undefined) continue;
		sp.append(key, String(value));
	}
	return sp.toString();
}

export function backoffDelayMs(attempt: number): number {
	// 250ms, 500ms, 1000ms, ... capped at 8s
	const base = 250 * 2 ** (attempt - 1);
	const capped = Math.min(base, 8000);
	const jitter = Math.floor(Math.random() * 100);
	return capped + jitter;
}

function parseEnvelope<T>(text: string, action: string, status: number): AdmToolsEnvelope<T> {
	try {
		return JSON.parse(text) as AdmToolsEnvelope<T>;
	} catch {
		throw new AdmToolsError(`adm.tools ${action} returned non-JSON body (HTTP ${status})`, {
			status,
			action,
			apiError: { rawBody: text.slice(0, 500) },
		});
	}
}

function safeJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return { rawBody: text.slice(0, 500) };
	}
}

function mapApiError(action: string, status: number, apiError: AdmToolsApiErrorBody): AdmToolsError {
	const code = String(apiError.code ?? "").toLowerCase();
	const message = String(apiError.message ?? "adm.tools returned result=false");
	if (code.includes("auth") || code.includes("token") || code === "401" || code === "403") {
		return new AdmToolsAuthError(`adm.tools auth error on ${action}: ${message}`, {
			status,
			action,
			apiError,
		});
	}
	return new AdmToolsError(`adm.tools ${action} error: ${message}`, { status, action, apiError });
}

/**
 * Pluck values out of an array OR a keyed object. adm.tools returns lists in
 * both shapes depending on endpoint and version (e.g. `dns/list` returns
 * `{ list: { "<domain>": {...} } }` — a map keyed by domain name).
 */
function collectItems(input: unknown): Record<string, unknown>[] {
	if (Array.isArray(input)) return input as Record<string, unknown>[];
	if (input && typeof input === "object") {
		return Object.values(input as Record<string, unknown>).filter(
			(v): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v),
		);
	}
	return [];
}

/**
 * Pull a flat list out of any of the shapes adm.tools uses for collections:
 * a bare array, `{ <containerKey>: [...] | { ... } }`, or the bare object
 * itself keyed by record id.
 */
function normalizeListResponse(data: unknown, containerKeys: readonly string[]): Record<string, unknown>[] {
	if (Array.isArray(data)) return data as Record<string, unknown>[];
	if (data && typeof data === "object") {
		const obj = data as Record<string, unknown>;
		for (const key of containerKeys) {
			if (obj[key] !== undefined) return collectItems(obj[key]);
		}
		return collectItems(obj);
	}
	return [];
}

function normalizeDomainList(data: unknown): DomainListItem[] {
	// Surface `id`/`domain`/`expires_at` regardless of which name the API used
	// today; keep all original fields so callers can still read metadata.
	return normalizeListResponse(data, ["list", "domains"]).map((item) => ({
		...item,
		id: (item.id ?? item.domain_id) as DomainListItem["id"],
		domain: (item.domain ?? item.name ?? "") as string,
		expires_at: (item.expires_at ?? item.valid_untill_formatted ?? item.valid_untill) as string | undefined,
	}));
}

function normalizeDnsRecords(data: unknown): DnsRecord[] {
	return normalizeListResponse(data, ["list", "records"]).filter((item) => "type" in item) as DnsRecord[];
}
