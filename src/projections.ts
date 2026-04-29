import type { ProjectionConfig } from "./llm-encode.js";

/**
 * Lean field projections for adm.tools list responses. Full payloads carry
 * 30-50 fields per item (most internal: `mnt_by_us`, `is_redemption`,
 * `transfer_out_review_status`, etc.). Keep-lists surface only the fields a
 * human or LLM agent would realistically consult.
 *
 * Pass `verbose: true` on the corresponding tool to retrieve the full payload.
 */

export const DOMAIN_LIST_LEAN: ProjectionConfig = {
	// `id`, `domain`, `expires_at` are the aliased fields the client always
	// surfaces (see normalizeDomainList) — we omit `domain_id` / `name` /
	// `valid_untill_formatted` to keep the row narrow.
	keep: ["id", "domain", "expires_at", "expired", "expire_soon", "status", "is_premium"],
};

export const DNS_RECORD_LIST_LEAN: ProjectionConfig = {
	keep: ["id", "subdomain_id", "type", "record", "data", "priority", "ttl"],
};
