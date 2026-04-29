import { describe, expect, it } from "bun:test";
import { ConfigError, loadConfig } from "../src/config.ts";

describe("loadConfig", () => {
	it("requires ADM_TOOLS_TOKEN", () => {
		expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(ConfigError);
	});

	it("rejects whitespace-only token", () => {
		expect(() => loadConfig({ ADM_TOOLS_TOKEN: "   " } as NodeJS.ProcessEnv)).toThrow(ConfigError);
	});

	it("provides sensible defaults", () => {
		const cfg = loadConfig({ ADM_TOOLS_TOKEN: "tok" } as NodeJS.ProcessEnv);
		expect(cfg.token).toBe("tok");
		expect(cfg.baseUrl).toBe("https://adm.tools");
		expect(cfg.timeoutMs).toBe(15_000);
		expect(cfg.maxRetries).toBe(3);
		expect(cfg.enableWriteTools).toBe(true);
	});

	it("strips trailing slashes from base URL", () => {
		const cfg = loadConfig({
			ADM_TOOLS_TOKEN: "tok",
			ADM_TOOLS_BASE_URL: "https://adm.tools///",
		} as NodeJS.ProcessEnv);
		expect(cfg.baseUrl).toBe("https://adm.tools");
	});

	it("parses numeric env vars", () => {
		const cfg = loadConfig({
			ADM_TOOLS_TOKEN: "tok",
			ADM_TOOLS_TIMEOUT_MS: "5000",
			ADM_TOOLS_MAX_RETRIES: "5",
		} as NodeJS.ProcessEnv);
		expect(cfg.timeoutMs).toBe(5000);
		expect(cfg.maxRetries).toBe(5);
	});

	it("rejects non-numeric numeric env vars", () => {
		expect(() =>
			loadConfig({ ADM_TOOLS_TOKEN: "tok", ADM_TOOLS_TIMEOUT_MS: "abc" } as NodeJS.ProcessEnv),
		).toThrow(ConfigError);
	});

	it("parses boolean env vars", () => {
		const cfg = loadConfig({
			ADM_TOOLS_TOKEN: "tok",
			ADM_TOOLS_ENABLE_WRITE_TOOLS: "false",
		} as NodeJS.ProcessEnv);
		expect(cfg.enableWriteTools).toBe(false);
	});

	it("rejects invalid boolean values", () => {
		expect(() =>
			loadConfig({
				ADM_TOOLS_TOKEN: "tok",
				ADM_TOOLS_ENABLE_WRITE_TOOLS: "maybe",
			} as NodeJS.ProcessEnv),
		).toThrow(ConfigError);
	});
});
