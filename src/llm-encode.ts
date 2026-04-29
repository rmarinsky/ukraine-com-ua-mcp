import { encode as toonEncode } from "@toon-format/toon";

export type LlmFormat = "toon" | "json";

export interface ProjectionConfig {
	/** Whitelist of fields to keep on every nested object/array element. Mutually exclusive with `drop`. */
	keep?: readonly string[];
	/** Blacklist of fields to drop from every nested object/array element. Mutually exclusive with `keep`. */
	drop?: readonly string[];
}

export interface EncodeForLlmOptions extends ProjectionConfig {
	/** Output syntax. TOON minimizes tokens for LLM consumption; JSON is the universal fallback. */
	format?: LlmFormat;
}

/**
 * Encode a payload for an LLM-readable text channel. TOON by default, JSON
 * via `format: "json"`. Optional `keep`/`drop` lists project nested object
 * fields to suppress noisy metadata before encoding.
 *
 * Pure: never mutates the input.
 */
export function encodeForLlm(payload: unknown, opts: EncodeForLlmOptions = {}): string {
	if (opts.keep && opts.drop) {
		throw new Error("encodeForLlm: pass either `keep` or `drop`, not both");
	}
	const format = opts.format ?? "toon";
	const projected = applyProjection(payload, opts);
	if (format === "json") return JSON.stringify(projected, null, 2);
	return toonEncode(projected as never);
}

/**
 * Apply `keep`/`drop` projection to the structuredContent value. We project
 * eagerly (instead of via TOON's `replacer`) so the same shape lands in
 * `structuredContent` and downstream consumers see the same fields the model
 * sees in the text channel.
 */
export function applyProjection(value: unknown, opts: ProjectionConfig): unknown {
	if (!opts.keep && !opts.drop) return value;
	return projectDeep(value, opts);
}

function projectDeep(value: unknown, opts: ProjectionConfig): unknown {
	if (Array.isArray(value)) return value.map((v) => projectDeep(v, opts));
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		const obj = value as Record<string, unknown>;
		if (opts.keep) {
			for (const key of opts.keep) {
				if (key in obj) out[key] = projectDeep(obj[key], opts);
			}
			return out;
		}
		const dropSet = new Set(opts.drop);
		for (const [key, v] of Object.entries(obj)) {
			if (dropSet.has(key)) continue;
			out[key] = projectDeep(v, opts);
		}
		return out;
	}
	return value;
}
