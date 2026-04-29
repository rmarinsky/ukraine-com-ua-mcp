/**
 * Shared types for adm.tools responses.
 *
 * adm.tools wraps every successful response in `{ result: true, response: ... }`
 * and every failure in `{ result: false, error: ... }`. We type the wrapper
 * tightly and keep the payloads loose: the API has no public OpenAPI spec and
 * fields appear and disappear without notice.
 */

export interface AdmToolsEnvelope<TResponse = unknown> {
	result: boolean;
	response?: TResponse;
	error?: AdmToolsApiErrorBody;
}

export interface AdmToolsApiErrorBody {
	code?: string | number;
	message?: string;
	[key: string]: unknown;
}

/**
 * Minimal shape of a domain in `dns/list`. The real response may include more
 * fields; we type only what we surface in tools.
 */
export interface DomainListItem {
	id: number | string;
	domain: string;
	expires_at?: string;
	expire?: string;
	status?: string;
	[key: string]: unknown;
}

/**
 * Minimal shape of a DNS record in `dns/records_list`.
 */
export interface DnsRecord {
	id: number | string;
	type: string;
	record: string;
	data: string;
	priority?: number;
	[key: string]: unknown;
}

/**
 * Supported DNS record types as accepted by `dns/record_add`. ALIAS, SRV, PTR,
 * and CAA are listed in the PHP reference and accepted in practice. Narrow
 * this enum if a user reports a type the API rejects.
 */
export const DNS_RECORD_TYPES = [
	"A",
	"AAAA",
	"CNAME",
	"MX",
	"TXT",
	"NS",
	"CAA",
	"ALIAS",
	"SRV",
	"PTR",
] as const;

export type DnsRecordType = (typeof DNS_RECORD_TYPES)[number];
