/**
 * Filesystem-backed snapshot store for DNS zones.
 *
 * Why this exists: adm.tools has no transactions, no version semantics, and no
 * native rollback. Before any mutation we take a hash-stamped snapshot of the
 * full zone. Each write tool then verifies the caller's `backup_id` still
 * matches the live zone — if not, the mutation is refused.
 *
 * The hash is computed over a canonical projection of the records (sorted by
 * `id`, stable JSON keys), so reordering or transient extra fields don't
 * destabilize it.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BackupError } from "./errors.js";
import type { DnsRecord } from "./types.js";

export interface BackupMetadata {
	backupId: string;
	path: string;
	domainId: string | number;
	recordCount: number;
	savedAt: number;
	expiresAt: number;
}

export interface BackupFile {
	domain_id: string | number;
	saved_at: number;
	backup_id: string;
	records: DnsRecord[];
}

export interface BackupStoreOptions {
	dir: string;
	maxAgeMs: number;
	now?: () => number;
}

export class BackupStore {
	private readonly dir: string;
	private readonly maxAgeMs: number;
	private readonly now: () => number;

	constructor(opts: BackupStoreOptions) {
		this.dir = opts.dir;
		this.maxAgeMs = opts.maxAgeMs;
		this.now = opts.now ?? (() => Date.now());
	}

	static hashZone(records: readonly DnsRecord[]): string {
		const canonical = [...records]
			.sort((a, b) => compareIds(a.id, b.id))
			.map((rec) => stableStringify(rec))
			.join("\n");
		return createHash("sha256").update(canonical).digest("hex");
	}

	async save(domainId: string | number, records: readonly DnsRecord[]): Promise<BackupMetadata> {
		await mkdir(this.dir, { recursive: true });
		const savedAt = this.now();
		const backupId = BackupStore.hashZone(records);
		const fileName = `${sanitizeId(domainId)}-${new Date(savedAt).toISOString().replace(/[:.]/g, "-")}-${backupId.slice(0, 12)}.json`;
		const path = join(this.dir, fileName);
		const file: BackupFile = {
			domain_id: domainId,
			saved_at: savedAt,
			backup_id: backupId,
			records: [...records],
		};
		await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
		return {
			backupId,
			path,
			domainId,
			recordCount: records.length,
			savedAt,
			expiresAt: savedAt + this.maxAgeMs,
		};
	}

	async load(domainId: string | number, backupId: string): Promise<BackupFile> {
		const file = await this.findFile(domainId, backupId);
		if (!file) {
			throw new BackupError(
				`Backup not found for domain_id=${domainId} backup_id=${backupId}`,
				"Run backup_dns_zone for this domain first",
			);
		}
		const raw = await readFile(file, "utf8");
		const parsed = JSON.parse(raw) as BackupFile;
		if (parsed.backup_id !== backupId) {
			throw new BackupError(
				`Backup file ${file} was tampered with (id mismatch: file=${parsed.backup_id} arg=${backupId})`,
			);
		}
		return parsed;
	}

	verifyMatches(backupId: string, currentRecords: readonly DnsRecord[]): boolean {
		return BackupStore.hashZone(currentRecords) === backupId;
	}

	isExpired(meta: { savedAt: number }): boolean {
		return this.now() - meta.savedAt > this.maxAgeMs;
	}

	private async findFile(domainId: string | number, backupId: string): Promise<string | null> {
		let entries: string[];
		try {
			entries = await readdir(this.dir);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw err;
		}
		const idPrefix = `${sanitizeId(domainId)}-`;
		const hashSuffix = `-${backupId.slice(0, 12)}.json`;
		const match = entries.find((name) => name.startsWith(idPrefix) && name.endsWith(hashSuffix));
		return match ? join(this.dir, match) : null;
	}
}

function compareIds(a: string | number, b: string | number): number {
	const an = Number(a);
	const bn = Number(b);
	if (!Number.isNaN(an) && !Number.isNaN(bn)) return an - bn;
	return String(a).localeCompare(String(b));
}

/**
 * JSON.stringify with deterministic key order. Recurses into objects so a
 * server-side reordering of fields doesn't change the hash.
 */
function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const obj = value as Record<string, unknown>;
	const keys = Object.keys(obj)
		.filter((k) => obj[k] !== undefined)
		.sort();
	const entries = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
	return `{${entries.join(",")}}`;
}

function sanitizeId(domainId: string | number): string {
	return String(domainId).replace(/[^A-Za-z0-9_-]/g, "_");
}
