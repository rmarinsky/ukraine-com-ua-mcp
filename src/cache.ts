/**
 * Tiny in-memory TTL cache. Used to dedupe calls like `list_domains` within
 * one MCP server lifetime. Not persisted, not shared between processes — by
 * design, since adm.tools state can change behind our back.
 */
export class TtlCache<TValue> {
	private readonly store = new Map<string, { value: TValue; expiresAt: number }>();

	constructor(private readonly defaultTtlMs: number) {}

	get(key: string): TValue | undefined {
		const hit = this.store.get(key);
		if (!hit) return undefined;
		if (hit.expiresAt <= Date.now()) {
			this.store.delete(key);
			return undefined;
		}
		return hit.value;
	}

	set(key: string, value: TValue, ttlMs?: number): void {
		const ttl = ttlMs ?? this.defaultTtlMs;
		this.store.set(key, { value, expiresAt: Date.now() + ttl });
	}

	delete(key: string): void {
		this.store.delete(key);
	}

	clear(): void {
		this.store.clear();
	}

	get size(): number {
		return this.store.size;
	}
}
