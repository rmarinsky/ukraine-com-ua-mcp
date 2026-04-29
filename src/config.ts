/**
 * Environment-based configuration. Token is required; everything else has a
 * sensible default. Loaded once at process start and treated as immutable.
 */

export interface Config {
	token: string;
	baseUrl: string;
	timeoutMs: number;
	maxRetries: number;
	domainCacheTtlMs: number;
	logFile?: string;
	enableWriteTools: boolean;
	backupDir: string;
	backupMaxAgeMs: number;
	requireBackup: boolean;
}

export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}

const DEFAULT_BASE_URL = "https://adm.tools";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_DOMAIN_CACHE_TTL_MS = 60 * 60 * 1000;
const DEFAULT_BACKUP_DIR = "./dns-backups";
const DEFAULT_BACKUP_MAX_AGE_MS = 10 * 60 * 1000;

function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
	const value = env[name];
	if (value === undefined || value === "") return undefined;
	return value;
}

function readNumber(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
	const raw = readEnv(env, name);
	if (raw === undefined) return fallback;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed < 0) {
		throw new ConfigError(`${name} must be a non-negative number, got ${JSON.stringify(raw)}`);
	}
	return parsed;
}

function readBoolean(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
	const raw = readEnv(env, name);
	if (raw === undefined) return fallback;
	const normalized = raw.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	throw new ConfigError(`${name} must be a boolean, got ${JSON.stringify(raw)}`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
	const token = env.ADM_TOOLS_TOKEN;
	if (!token || token.trim() === "") {
		throw new ConfigError(
			"ADM_TOOLS_TOKEN is required. Get one from https://adm.tools/user/api/ and export it as an env var.",
		);
	}

	return {
		token: token.trim(),
		baseUrl: (readEnv(env, "ADM_TOOLS_BASE_URL") ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
		timeoutMs: readNumber(env, "ADM_TOOLS_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
		maxRetries: readNumber(env, "ADM_TOOLS_MAX_RETRIES", DEFAULT_MAX_RETRIES),
		domainCacheTtlMs: readNumber(env, "ADM_TOOLS_DOMAIN_CACHE_TTL_MS", DEFAULT_DOMAIN_CACHE_TTL_MS),
		logFile: readEnv(env, "ADM_TOOLS_LOG_FILE"),
		enableWriteTools: readBoolean(env, "ADM_TOOLS_ENABLE_WRITE_TOOLS", true),
		backupDir: readEnv(env, "ADM_TOOLS_BACKUP_DIR") ?? DEFAULT_BACKUP_DIR,
		backupMaxAgeMs: readNumber(env, "ADM_TOOLS_BACKUP_MAX_AGE_MS", DEFAULT_BACKUP_MAX_AGE_MS),
		requireBackup: readBoolean(env, "ADM_TOOLS_REQUIRE_BACKUP", true),
	};
}
