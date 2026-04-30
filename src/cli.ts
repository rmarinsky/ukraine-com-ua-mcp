#!/usr/bin/env node
/**
 * Standalone CLI mirroring the MCP tools. Useful to debug the API without
 * spinning up an MCP client. Usage:
 *
 *   ADM_TOOLS_TOKEN=… bun run src/cli.ts list-domains
 *   ADM_TOOLS_TOKEN=… bun run src/cli.ts check rmarinsky.com.ua
 *   ADM_TOOLS_TOKEN=… bun run src/cli.ts list-records 12345
 *   ADM_TOOLS_TOKEN=… bun run src/cli.ts call dns/list
 */

import { AdmToolsClient } from "./admtools.js";
import { ConfigError, loadConfig } from "./config.js";
import { AdmToolsAuthError, AdmToolsError } from "./errors.js";

const USAGE = `
ukraine-com-ua-mcp CLI

  list-domains
  check <domain>
  balance
  list-records <domain_id>
  call <action> [k=v ...]

Reads ADM_TOOLS_TOKEN from env. See .env.example for all settings.
`.trim();

function parseKvs(args: string[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (const arg of args) {
		const eq = arg.indexOf("=");
		if (eq <= 0) continue;
		out[arg.slice(0, eq)] = arg.slice(eq + 1);
	}
	return out;
}

function print(value: unknown) {
	console.log(JSON.stringify(value, null, 2));
}

async function main() {
	const [, , command, ...rest] = process.argv;
	if (!command || command === "-h" || command === "--help") {
		console.log(USAGE);
		process.exit(command ? 0 : 1);
	}

	const config = loadConfig();
	const client = new AdmToolsClient({
		token: config.token,
		baseUrl: config.baseUrl,
		timeoutMs: config.timeoutMs,
		maxRetries: config.maxRetries,
		logFile: config.logFile,
	});

	switch (command) {
		case "list-domains": {
			print(await client.listDomains());
			return;
		}
		case "check": {
			const domain = rest[0];
			if (!domain) throw new Error("domain required");
			print(await client.checkDomainAvailability(domain));
			return;
		}
		case "balance": {
			print(await client.getBalance());
			return;
		}
		case "list-records": {
			const id = rest[0];
			if (!id) throw new Error("domain_id required");
			print(await client.listDnsRecords(id));
			return;
		}
		case "call": {
			const [action, ...kvs] = rest;
			if (!action) throw new Error("action required, e.g. 'dns/list'");
			print(await client.call(action, parseKvs(kvs)));
			return;
		}
		default:
			console.error(`Unknown command: ${command}`);
			console.error(USAGE);
			process.exit(1);
	}
}

main().catch((err) => {
	if (err instanceof ConfigError) {
		console.error(`config error: ${err.message}`);
		process.exit(2);
	}
	if (err instanceof AdmToolsAuthError) {
		console.error(`auth error: ${err.message}`);
		process.exit(3);
	}
	if (err instanceof AdmToolsError) {
		console.error(`api error on ${err.action}: ${err.message}`);
		console.error(JSON.stringify({ status: err.status, apiError: err.apiError }, null, 2));
		process.exit(4);
	}
	console.error(`fatal: ${(err as Error).message ?? String(err)}`);
	process.exit(1);
});
