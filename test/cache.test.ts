import { describe, expect, it } from "bun:test";
import { TtlCache } from "../src/cache.ts";

describe("TtlCache", () => {
	it("returns undefined for missing keys", () => {
		const c = new TtlCache<string>(1000);
		expect(c.get("x")).toBeUndefined();
	});

	it("returns set values within TTL", () => {
		const c = new TtlCache<number>(1000);
		c.set("x", 42);
		expect(c.get("x")).toBe(42);
	});

	it("expires entries past TTL", async () => {
		const c = new TtlCache<number>(10);
		c.set("x", 1);
		await new Promise((r) => setTimeout(r, 25));
		expect(c.get("x")).toBeUndefined();
	});

	it("delete removes entries", () => {
		const c = new TtlCache<number>(1000);
		c.set("x", 1);
		c.delete("x");
		expect(c.get("x")).toBeUndefined();
	});

	it("clear empties the cache", () => {
		const c = new TtlCache<number>(1000);
		c.set("x", 1);
		c.set("y", 2);
		c.clear();
		expect(c.size).toBe(0);
	});

	it("per-set TTL overrides default", async () => {
		const c = new TtlCache<number>(60_000);
		c.set("x", 1, 10);
		await new Promise((r) => setTimeout(r, 25));
		expect(c.get("x")).toBeUndefined();
	});
});
