import { describe, expect, it } from "bun:test";
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT, paginate } from "../src/paginate.ts";

describe("paginate", () => {
	const items = Array.from({ length: 120 }, (_, i) => ({ id: i }));

	it("uses defaults when no opts passed", () => {
		const page = paginate(items);
		expect(page.limit).toBe(DEFAULT_PAGE_LIMIT);
		expect(page.offset).toBe(0);
		expect(page.items).toHaveLength(DEFAULT_PAGE_LIMIT);
		expect(page.total).toBe(120);
		expect(page.has_more).toBe(true);
		expect(page.next_offset).toBe(DEFAULT_PAGE_LIMIT);
	});

	it("slices according to limit/offset", () => {
		const page = paginate(items, { limit: 10, offset: 100 });
		expect(page.items).toHaveLength(10);
		expect(page.items[0]).toEqual({ id: 100 });
		expect(page.items[9]).toEqual({ id: 109 });
		expect(page.next_offset).toBe(110);
		expect(page.has_more).toBe(true);
	});

	it("clamps limit above MAX_PAGE_LIMIT", () => {
		const page = paginate(items, { limit: MAX_PAGE_LIMIT * 10 });
		expect(page.limit).toBe(MAX_PAGE_LIMIT);
	});

	it("falls back to default limit on non-positive limit", () => {
		expect(paginate(items, { limit: 0 }).limit).toBe(DEFAULT_PAGE_LIMIT);
		expect(paginate(items, { limit: -5 }).limit).toBe(DEFAULT_PAGE_LIMIT);
	});

	it("treats out-of-range offset as zero", () => {
		expect(paginate(items, { offset: -10 }).offset).toBe(0);
	});

	it("reports has_more=false and next_offset=null at the end", () => {
		const page = paginate(items, { limit: 50, offset: 100 });
		expect(page.items).toHaveLength(20);
		expect(page.has_more).toBe(false);
		expect(page.next_offset).toBe(null);
	});

	it("handles empty input", () => {
		const page = paginate([]);
		expect(page.items).toHaveLength(0);
		expect(page.total).toBe(0);
		expect(page.has_more).toBe(false);
		expect(page.next_offset).toBe(null);
	});
});
