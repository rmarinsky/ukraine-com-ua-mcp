/**
 * Client-side pagination over a fully-fetched list. adm.tools doesn't expose
 * server-side pagination, but the lists are bounded (account size for domains,
 * zone size for DNS records) so slicing locally is cheap and lets the LLM
 * consume one page at a time without filling the context window.
 */

export interface PaginateOptions {
	limit?: number;
	offset?: number;
}

export interface PaginatedResult<T> {
	items: T[];
	total: number;
	limit: number;
	offset: number;
	has_more: boolean;
	next_offset: number | null;
}

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 500;

export function paginate<T>(items: readonly T[], opts: PaginateOptions = {}): PaginatedResult<T> {
	const total = items.length;
	const offset = clampNonNegative(opts.offset ?? 0);
	const limit = clampLimit(opts.limit);
	const slice = items.slice(offset, offset + limit);
	const nextOffset = offset + slice.length;
	const hasMore = nextOffset < total;
	return {
		items: slice,
		total,
		limit,
		offset,
		has_more: hasMore,
		next_offset: hasMore ? nextOffset : null,
	};
}

function clampLimit(raw: number | undefined): number {
	if (raw === undefined) return DEFAULT_PAGE_LIMIT;
	if (raw <= 0) return DEFAULT_PAGE_LIMIT;
	return Math.min(Math.floor(raw), MAX_PAGE_LIMIT);
}

function clampNonNegative(n: number): number {
	if (!Number.isFinite(n) || n < 0) return 0;
	return Math.floor(n);
}
