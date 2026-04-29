import { describe, expect, it } from "bun:test";
import type { Config } from "../src/config.ts";
import { buildServer } from "../src/server.ts";

const baseConfig: Config = {
	token: "tok",
	baseUrl: "https://example.invalid",
	timeoutMs: 15_000,
	maxRetries: 3,
	domainCacheTtlMs: 1000,
	enableWriteTools: true,
	backupDir: "./dns-backups",
	backupMaxAgeMs: 600_000,
	requireBackup: true,
};

/**
 * The MCP SDK doesn't expose a public introspection API for registered tools.
 * We poke at the internal map via a typed cast — only used in tests, so the
 * cast is contained and the test will surface immediately if the SDK's shape
 * changes (which would also force us to update the production server code).
 */
function listToolNames(server: ReturnType<typeof buildServer>): string[] {
	const internal = server as unknown as { _registeredTools?: Record<string, unknown> };
	if (internal._registeredTools) return Object.keys(internal._registeredTools);
	// Fallback: walk all own props for a Map-like that contains tool names.
	for (const value of Object.values(server as unknown as Record<string, unknown>)) {
		if (value instanceof Map) return [...value.keys()].map(String);
		if (value && typeof value === "object" && "check_domain_availability" in (value as object)) {
			return Object.keys(value as object);
		}
	}
	return [];
}

function getToolSchemaKeys(server: ReturnType<typeof buildServer>, name: string): string[] {
	const internal = server as unknown as {
		_registeredTools?: Record<string, { inputSchema?: { shape?: Record<string, unknown> } }>;
	};
	const tool = internal._registeredTools?.[name];
	const shape = tool?.inputSchema?.shape;
	return shape ? Object.keys(shape) : [];
}

describe("buildServer", () => {
	it("registers every verified-live tool when writes are enabled", () => {
		const server = buildServer(baseConfig);
		const names = listToolNames(server);
		const expected = [
			"check_domain_availability",
			"list_domains",
			"list_dns_records",
			"backup_dns_zone",
			"create_dns_record",
			"update_dns_record",
			"delete_dns_record",
			"restore_dns_zone",
			"get_balance",
		];
		for (const name of expected) {
			expect(names).toContain(name);
		}
	});

	it("hides destructive and write-only tools when writes are disabled", () => {
		const server = buildServer({ ...baseConfig, enableWriteTools: false });
		const names = listToolNames(server);
		expect(names).toContain("list_domains");
		expect(names).toContain("list_dns_records");
		expect(names).toContain("check_domain_availability");
		expect(names).toContain("get_balance");
		expect(names).not.toContain("create_dns_record");
		expect(names).not.toContain("update_dns_record");
		expect(names).not.toContain("delete_dns_record");
		expect(names).not.toContain("backup_dns_zone");
		expect(names).not.toContain("restore_dns_zone");
	});

	it("write tools include backup_id and domain_id in their input schema", () => {
		const server = buildServer(baseConfig);
		for (const name of ["create_dns_record", "update_dns_record", "delete_dns_record"]) {
			const keys = getToolSchemaKeys(server, name);
			expect(keys).toContain("backup_id");
			expect(keys).toContain("domain_id");
		}
	});

	it("update_dns_record keeps subdomain_id alongside the new domain_id", () => {
		const server = buildServer(baseConfig);
		const keys = getToolSchemaKeys(server, "update_dns_record");
		expect(keys).toContain("subdomain_id");
		expect(keys).toContain("domain_id");
	});

	it("restore_dns_zone is a destructive tool with confirm + backup_id", () => {
		const server = buildServer(baseConfig);
		const keys = getToolSchemaKeys(server, "restore_dns_zone");
		expect(keys).toContain("domain_id");
		expect(keys).toContain("backup_id");
		expect(keys).toContain("confirm");
	});
});
