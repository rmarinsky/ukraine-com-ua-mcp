import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackupStore } from "../src/backup-store.ts";
import { BackupError } from "../src/errors.ts";
import type { DnsRecord } from "../src/types.ts";

const SAMPLE: DnsRecord[] = [
	{ id: 2, type: "A", record: "@", data: "1.2.3.4" },
	{ id: 1, type: "MX", record: "@", data: "mx.example.com", priority: 10 },
	{ id: 3, type: "TXT", record: "_dmarc", data: "v=DMARC1; p=none" },
];

describe("BackupStore.hashZone", () => {
	it("is deterministic regardless of record order", () => {
		const a = BackupStore.hashZone(SAMPLE);
		const b = BackupStore.hashZone([...SAMPLE].reverse());
		expect(a).toBe(b);
	});

	it("is deterministic regardless of object key order within a record", () => {
		const reordered: DnsRecord[] = SAMPLE.map((r) => ({
			data: r.data,
			priority: r.priority,
			type: r.type,
			record: r.record,
			id: r.id,
		}));
		expect(BackupStore.hashZone(reordered)).toBe(BackupStore.hashZone(SAMPLE));
	});

	it("changes when any record value changes", () => {
		const original = BackupStore.hashZone(SAMPLE);
		const mutated = BackupStore.hashZone([
			{ ...SAMPLE[0], data: "9.9.9.9" } as DnsRecord,
			SAMPLE[1] as DnsRecord,
			SAMPLE[2] as DnsRecord,
		]);
		expect(mutated).not.toBe(original);
	});

	it("returns hex digits only", () => {
		expect(BackupStore.hashZone(SAMPLE)).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe("BackupStore filesystem", () => {
	let dir: string;
	let store: BackupStore;
	let now = Date.now();

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "ukr-mcp-backup-"));
		now = Date.now();
		store = new BackupStore({ dir, maxAgeMs: 60_000, now: () => now });
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("save creates a JSON file with the snapshot and returns metadata", async () => {
		const meta = await store.save(12345, SAMPLE);

		expect(meta.backupId).toMatch(/^[0-9a-f]{64}$/);
		expect(meta.recordCount).toBe(3);
		expect(meta.savedAt).toBe(now);
		expect(meta.expiresAt).toBe(now + 60_000);
		expect(meta.path.endsWith(".json")).toBe(true);

		const raw = JSON.parse(await readFile(meta.path, "utf8"));
		expect(raw.domain_id).toBe(12345);
		expect(raw.backup_id).toBe(meta.backupId);
		expect(raw.records).toHaveLength(3);
	});

	it("load returns the saved snapshot by exact backup_id", async () => {
		const meta = await store.save(12345, SAMPLE);
		const loaded = await store.load(12345, meta.backupId);
		expect(loaded.backup_id).toBe(meta.backupId);
		expect(loaded.records).toHaveLength(3);
	});

	it("load throws BackupError for an unknown backup_id", async () => {
		await store.save(12345, SAMPLE);
		await expect(store.load(12345, "deadbeef".repeat(8))).rejects.toBeInstanceOf(BackupError);
	});

	it("load throws BackupError when the directory does not exist", async () => {
		const missing = new BackupStore({ dir: join(dir, "does-not-exist"), maxAgeMs: 60_000 });
		await expect(missing.load(1, "a".repeat(64))).rejects.toBeInstanceOf(BackupError);
	});

	it("verifyMatches is true for unchanged records and false otherwise", async () => {
		const meta = await store.save(12345, SAMPLE);
		expect(store.verifyMatches(meta.backupId, SAMPLE)).toBe(true);
		expect(
			store.verifyMatches(meta.backupId, [
				{ ...SAMPLE[0], data: "9.9.9.9" } as DnsRecord,
				SAMPLE[1] as DnsRecord,
				SAMPLE[2] as DnsRecord,
			]),
		).toBe(false);
	});

	it("isExpired flips true after maxAgeMs elapses", async () => {
		const meta = await store.save(12345, SAMPLE);
		expect(store.isExpired(meta)).toBe(false);
		now += 60_001;
		expect(store.isExpired(meta)).toBe(true);
	});

	it("sanitizes a domain_id with unsafe filename characters", async () => {
		const meta = await store.save("../weird/id", SAMPLE);
		expect(meta.path.includes("..")).toBe(false);
		expect(meta.path.includes("/weird/")).toBe(false);
	});
});
