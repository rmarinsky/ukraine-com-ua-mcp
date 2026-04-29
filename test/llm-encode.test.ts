import { describe, expect, it } from "bun:test";
import { applyProjection, encodeForLlm } from "../src/llm-encode.ts";

describe("encodeForLlm", () => {
	it("emits TOON by default", () => {
		const out = encodeForLlm({ id: 1, name: "foo" });
		expect(out).not.toContain("{");
		expect(out).toContain("id: 1");
		expect(out).toContain("name: foo");
	});

	it("falls back to JSON via format: 'json'", () => {
		const out = encodeForLlm({ id: 1, name: "foo" }, { format: "json" });
		const parsed = JSON.parse(out);
		expect(parsed).toEqual({ id: 1, name: "foo" });
	});

	it("emits TOON tabular form for arrays of uniform objects", () => {
		const out = encodeForLlm({
			items: [
				{ id: 1, type: "A", record: "@", data: "1.2.3.4" },
				{ id: 2, type: "MX", record: "@", data: "mx.example.com" },
			],
		});
		// TOON tabular array: header line declares fields, rows follow
		expect(out).toContain("items[2]");
		expect(out).toContain("id,type,record,data");
		expect(out).toContain("1,A,@,1.2.3.4");
	});

	it("applies keep projection", () => {
		const out = encodeForLlm(
			{ id: 1, domain: "a.com", trash: "noisy", more_trash: { x: 1 } },
			{
				keep: ["id", "domain"],
				format: "json",
			},
		);
		const parsed = JSON.parse(out);
		expect(parsed).toEqual({ id: 1, domain: "a.com" });
	});

	it("applies drop projection", () => {
		const out = encodeForLlm(
			{ id: 1, domain: "a.com", trash: "noisy" },
			{
				drop: ["trash"],
				format: "json",
			},
		);
		const parsed = JSON.parse(out);
		expect(parsed).toEqual({ id: 1, domain: "a.com" });
	});

	it("projects nested arrays of objects element-by-element", () => {
		const out = encodeForLlm(
			{
				items: [
					{ id: 1, trash: "x" },
					{ id: 2, trash: "y" },
				],
			},
			{ keep: ["items", "id"], format: "json" },
		);
		const parsed = JSON.parse(out);
		expect(parsed).toEqual({ items: [{ id: 1 }, { id: 2 }] });
	});

	it("rejects passing both keep and drop", () => {
		expect(() => encodeForLlm({ id: 1 }, { keep: ["id"], drop: ["x"] })).toThrow(/either.*keep.*or.*drop/i);
	});
});

describe("applyProjection", () => {
	it("returns input unchanged when no keep/drop given", () => {
		const input = { a: 1, b: { c: 2 } };
		const out = applyProjection(input, {});
		expect(out).toEqual(input);
	});

	it("recursively projects through arrays and nested objects", () => {
		const out = applyProjection(
			{
				wrapper: {
					rows: [
						{ id: 1, junk: "a", more: { z: 1 } },
						{ id: 2, junk: "b" },
					],
				},
			},
			{ keep: ["wrapper", "rows", "id"] },
		);
		expect(out).toEqual({ wrapper: { rows: [{ id: 1 }, { id: 2 }] } });
	});

	it("keeps primitives untouched", () => {
		expect(applyProjection(42, { drop: ["foo"] })).toBe(42);
		expect(applyProjection("hi", { keep: ["foo"] })).toBe("hi");
		expect(applyProjection(null, { drop: ["foo"] })).toBe(null);
	});
});
