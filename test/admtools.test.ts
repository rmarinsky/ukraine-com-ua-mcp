import { beforeEach, describe, expect, it, mock } from "bun:test";
import { AdmToolsClient, backoffDelayMs, encodeForm } from "../src/admtools.ts";
import { AdmToolsAuthError, AdmToolsError } from "../src/errors.ts";

interface MockCall {
	url: string;
	init: RequestInit;
}

/**
 * A scriptable fake fetch. Each `enqueue` adds one response that is returned
 * by the next call; if the queue is empty, the test fails.
 */
function makeFakeFetch() {
	const calls: MockCall[] = [];
	const responses: Response[] = [];

	const enqueue = (status: number, body: unknown) => {
		const text = typeof body === "string" ? body : JSON.stringify(body);
		responses.push(new Response(text, { status, headers: { "content-type": "application/json" } }));
	};

	const enqueueRaw = (response: Response) => {
		responses.push(response);
	};

	const fetchImpl = mock(async (url: string | URL | Request, init?: RequestInit) => {
		const next = responses.shift();
		if (!next) throw new Error("fakeFetch: queue empty");
		calls.push({ url: String(url), init: init ?? {} });
		return next;
	});

	return { fetchImpl, calls, enqueue, enqueueRaw };
}

function makeClient(overrides: Partial<ConstructorParameters<typeof AdmToolsClient>[0]> = {}) {
	const fake = makeFakeFetch();
	const sleeps: number[] = [];
	const client = new AdmToolsClient({
		token: "tok-123",
		baseUrl: "https://example.invalid",
		timeoutMs: 5_000,
		maxRetries: 3,
		fetchImpl: fake.fetchImpl as unknown as typeof fetch,
		sleep: async (ms) => {
			sleeps.push(ms);
		},
		...overrides,
	});
	return { client, fake, sleeps };
}

describe("encodeForm", () => {
	it("serializes string/number/boolean", () => {
		expect(encodeForm({ a: "x", b: 1, c: true })).toBe("a=x&b=1&c=true");
	});

	it("skips undefined values but keeps zero, false, and empty string", () => {
		expect(encodeForm({ a: undefined, b: 0, c: false, d: "" })).toBe("b=0&c=false&d=");
	});

	it("URL-encodes values", () => {
		expect(encodeForm({ q: "a b&c=d" })).toBe("q=a+b%26c%3Dd");
	});
});

describe("backoffDelayMs", () => {
	it("doubles per attempt and caps at 8s", () => {
		expect(backoffDelayMs(1)).toBeGreaterThanOrEqual(250);
		expect(backoffDelayMs(1)).toBeLessThan(250 + 100);
		expect(backoffDelayMs(2)).toBeGreaterThanOrEqual(500);
		expect(backoffDelayMs(2)).toBeLessThan(500 + 100);
		expect(backoffDelayMs(20)).toBeLessThanOrEqual(8000 + 100);
	});
});

describe("AdmToolsClient construction", () => {
	it("requires a non-empty token", () => {
		expect(() => new AdmToolsClient({ token: "" })).toThrow(/token/);
		expect(() => new AdmToolsClient({ token: "   " })).toThrow(/token/);
	});

	it("strips trailing slashes from baseUrl", async () => {
		const { client, fake } = makeClient({ baseUrl: "https://example.invalid///" });
		fake.enqueue(200, { result: true, response: { ok: 1 } });
		await client.call("dns/list");
		expect(fake.calls[0]?.url).toBe("https://example.invalid/action/dns/list/");
	});
});

describe("call() — happy path", () => {
	it("sends POST with bearer auth and form body", async () => {
		const { client, fake } = makeClient();
		fake.enqueue(200, { result: true, response: { foo: "bar" } });

		const data = await client.call("dns/list", { id: 7, on: true });

		expect(data).toEqual({ foo: "bar" });
		expect(fake.calls).toHaveLength(1);
		const call = fake.calls[0]!;
		expect(call.url).toBe("https://example.invalid/action/dns/list/");
		expect(call.init.method).toBe("POST");
		const headers = call.init.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer tok-123");
		expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
		expect(call.init.body).toBe("id=7&on=true");
	});

	it("returns empty object when response field is missing", async () => {
		const { client, fake } = makeClient();
		fake.enqueue(200, { result: true });
		const data = await client.call("dns/list");
		expect(data).toEqual({});
	});
});

describe("call() — error mapping", () => {
	it("throws AdmToolsAuthError on HTTP 401", async () => {
		const { client, fake } = makeClient();
		fake.enqueue(401, { error: { message: "bad token" } });
		await expect(client.call("dns/list")).rejects.toBeInstanceOf(AdmToolsAuthError);
	});

	it("throws AdmToolsAuthError on HTTP 403", async () => {
		const { client, fake } = makeClient();
		fake.enqueue(403, { error: { message: "forbidden" } });
		await expect(client.call("dns/list")).rejects.toBeInstanceOf(AdmToolsAuthError);
	});

	it("does NOT retry on 4xx (other than 429)", async () => {
		const { client, fake, sleeps } = makeClient();
		fake.enqueue(400, { error: { message: "bad" } });
		await expect(client.call("dns/list")).rejects.toBeInstanceOf(AdmToolsError);
		expect(fake.calls).toHaveLength(1);
		expect(sleeps).toHaveLength(0);
	});

	it("retries 5xx with backoff up to maxRetries+1 attempts then throws", async () => {
		const { client, fake, sleeps } = makeClient({ maxRetries: 2 });
		fake.enqueue(503, "service unavailable");
		fake.enqueue(503, "service unavailable");
		fake.enqueue(503, "service unavailable");

		await expect(client.call("dns/list")).rejects.toBeInstanceOf(AdmToolsError);
		expect(fake.calls).toHaveLength(3); // initial + 2 retries
		expect(sleeps).toHaveLength(2);
	});

	it("retries 429 then succeeds", async () => {
		const { client, fake, sleeps } = makeClient({ maxRetries: 3 });
		fake.enqueue(429, { error: { message: "slow down" } });
		fake.enqueue(200, { result: true, response: { ok: 1 } });

		const data = await client.call("dns/list");
		expect(data).toEqual({ ok: 1 });
		expect(fake.calls).toHaveLength(2);
		expect(sleeps).toHaveLength(1);
	});

	it("maps result=false with auth-flavoured code to AdmToolsAuthError", async () => {
		const { client, fake } = makeClient();
		fake.enqueue(200, { result: false, error: { code: "auth_failed", message: "token expired" } });
		await expect(client.call("dns/list")).rejects.toBeInstanceOf(AdmToolsAuthError);
	});

	it("maps result=false with other code to AdmToolsError", async () => {
		const { client, fake } = makeClient();
		fake.enqueue(200, { result: false, error: { code: "domain_not_found", message: "no such domain" } });
		await expect(client.call("dns/list")).rejects.toBeInstanceOf(AdmToolsError);
	});

	it("throws AdmToolsError on non-JSON 200 body", async () => {
		const { client, fake } = makeClient();
		fake.enqueueRaw(new Response("<html>nope</html>", { status: 200 }));
		await expect(client.call("dns/list")).rejects.toThrow(/non-JSON/);
	});

	it("retries network errors", async () => {
		const calls: MockCall[] = [];
		let attempts = 0;
		const sleeps: number[] = [];
		const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(url), init: init ?? {} });
			attempts += 1;
			if (attempts === 1) throw new Error("ECONNRESET");
			return new Response(JSON.stringify({ result: true, response: { ok: 1 } }), { status: 200 });
		}) as unknown as typeof fetch;
		const client = new AdmToolsClient({
			token: "tok",
			baseUrl: "https://example.invalid",
			fetchImpl,
			sleep: async (ms) => {
				sleeps.push(ms);
			},
		});
		const data = await client.call("dns/list");
		expect(data).toEqual({ ok: 1 });
		expect(calls).toHaveLength(2);
		expect(sleeps).toHaveLength(1);
	});
});

describe("typed wrappers send the right form fields", () => {
	let cap: ReturnType<typeof makeClient>;

	beforeEach(() => {
		cap = makeClient();
	});

	const lastBody = () => cap.fake.calls.at(-1)?.init.body as string;

	it("checkDomainAvailability sends domain", async () => {
		cap.fake.enqueue(200, { result: true, response: { available: true } });
		await cap.client.checkDomainAvailability("rmarinsky.com.ua");
		expect(lastBody()).toBe("domain=rmarinsky.com.ua");
		expect(cap.fake.calls[0]?.url).toContain("/action/domain/check/");
	});

	it("listDomains hits dns/list and unwraps {list:[]}", async () => {
		cap.fake.enqueue(200, {
			result: true,
			response: {
				list: [
					{ id: 1, domain: "a.com" },
					{ id: 2, domain: "b.com" },
				],
			},
		});
		const out = await cap.client.listDomains();
		expect(out).toHaveLength(2);
		expect(out[0]?.domain).toBe("a.com");
	});

	it("listDomains accepts plain array shape", async () => {
		cap.fake.enqueue(200, {
			result: true,
			response: [{ id: 1, domain: "a.com" }],
		});
		const out = await cap.client.listDomains();
		expect(out[0]?.id).toBe(1);
		expect(out[0]?.domain).toBe("a.com");
	});

	it("listDomains normalizes the real adm.tools shape (list keyed by domain, fields domain_id/name)", async () => {
		cap.fake.enqueue(200, {
			result: true,
			response: {
				list: {
					"mnfaktr.com": {
						domain_id: 1969065,
						name: "mnfaktr.com",
						valid_untill: "2029-01-11",
						valid_untill_formatted: "11.01.2029",
						expired: "0",
					},
					"partyhard.com.ua": {
						domain_id: 1975817,
						name: "partyhard.com.ua",
						valid_untill: "2027-01-28",
						valid_untill_formatted: "28.01.2027",
						expired: "0",
					},
				},
			},
		});
		const out = await cap.client.listDomains();
		expect(out).toHaveLength(2);
		expect(out[0]?.id).toBe(1969065);
		expect(out[0]?.domain).toBe("mnfaktr.com");
		expect(out[0]?.expires_at).toBe("11.01.2029");
		expect(out[1]?.id).toBe(1975817);
		expect(out[1]?.domain).toBe("partyhard.com.ua");
	});

	it("createDnsRecord includes priority only when provided", async () => {
		cap.fake.enqueue(200, { result: true, response: { id: 99 } });
		await cap.client.createDnsRecord({
			domainId: 7,
			type: "A",
			record: "@",
			data: "1.2.3.4",
		});
		expect(lastBody()).toBe("domain_id=7&type=A&record=%40&data=1.2.3.4");

		cap.fake.enqueue(200, { result: true, response: { id: 100 } });
		await cap.client.createDnsRecord({
			domainId: 7,
			type: "MX",
			record: "@",
			data: "mx.example.com",
			priority: 10,
		});
		expect(lastBody()).toBe("domain_id=7&type=MX&record=%40&data=mx.example.com&priority=10");
	});

	it("updateDnsRecord uses subdomain_id (not id)", async () => {
		cap.fake.enqueue(200, { result: true, response: {} });
		await cap.client.updateDnsRecord({
			subdomainId: 555,
			type: "TXT",
			record: "_dmarc",
			data: "v=DMARC1; p=reject;",
		});
		const body = lastBody();
		expect(body).toContain("subdomain_id=555");
		expect(body).not.toMatch(/\bid=555\b/);
	});

	it("deleteDnsRecord uses subdomain_id", async () => {
		cap.fake.enqueue(200, { result: true, response: {} });
		await cap.client.deleteDnsRecord({ subdomainId: 42 });
		expect(lastBody()).toBe("subdomain_id=42");
	});

	it("getBalance hits billing/balance_get", async () => {
		cap.fake.enqueue(200, { result: true, response: { balance: 42 } });
		await cap.client.getBalance();
		expect(cap.fake.calls[0]?.url).toContain("/action/billing/balance_get/");
	});

	it("checkDomainAvailability hits domain/check (not dns/domain_check)", async () => {
		cap.fake.enqueue(200, { result: true, response: {} });
		await cap.client.checkDomainAvailability("rmarinsky.com.ua");
		expect(cap.fake.calls[0]?.url).toContain("/action/domain/check/");
	});
});

/**
 * Regression: production adm.tools wants `domain_id` (not `id`) on every
 * endpoint that scopes to a domain. Earlier reverse-engineered docs said
 * `id`; the API rejects that with HTTP 422
 * «Відсутнє значення параметра _POST[domain_id]».
 * Re-probing rule: if these tests flip, re-run the live API before changing
 * the assertion — adm.tools may have changed conventions.
 */
describe("regression: domain-scoped endpoints send domain_id", () => {
	const cases: ReadonlyArray<[string, (c: AdmToolsClient) => Promise<unknown>, string]> = [
		["listDnsRecords", (c) => c.listDnsRecords(123), "/action/dns/records_list/"],
		[
			"createDnsRecord",
			(c) => c.createDnsRecord({ domainId: 123, type: "A", record: "@", data: "1.2.3.4" }),
			"/action/dns/record_add/",
		],
	];

	for (const [name, invoke, expectedUrlSuffix] of cases) {
		it(`${name} sends domain_id, not id, to ${expectedUrlSuffix}`, async () => {
			const { client, fake } = makeClient();
			fake.enqueue(200, { result: true, response: {} });
			await invoke(client);
			const call = fake.calls[0]!;
			expect(call.url).toContain(expectedUrlSuffix);
			const body = call.init.body as string;
			expect(body).toContain("domain_id=123");
			expect(body).not.toMatch(/(^|&)id=123(&|$)/);
		});
	}
});

/**
 * Regression: record-scoped endpoints continue to use `subdomain_id`.
 */
describe("regression: record-scoped endpoints send subdomain_id", () => {
	it("updateDnsRecord", async () => {
		const { client, fake } = makeClient();
		fake.enqueue(200, { result: true, response: {} });
		await client.updateDnsRecord({ subdomainId: 999, type: "A", record: "@", data: "1.1.1.1" });
		const body = fake.calls[0]?.init.body as string;
		expect(body).toContain("subdomain_id=999");
		expect(body).not.toMatch(/(^|&)domain_id=/);
	});

	it("deleteDnsRecord", async () => {
		const { client, fake } = makeClient();
		fake.enqueue(200, { result: true, response: {} });
		await client.deleteDnsRecord({ subdomainId: 999 });
		const body = fake.calls[0]?.init.body as string;
		expect(body).toBe("subdomain_id=999");
	});
});

describe("logging", () => {
	it("never writes the token to log files", async () => {
		const tmp = `${process.env.TMPDIR ?? "/tmp"}/admtools-test-${Date.now()}.log`;
		const fake = makeFakeFetch();
		fake.enqueue(200, { result: true, response: {} });
		const client = new AdmToolsClient({
			token: "super-secret-token-XYZ",
			baseUrl: "https://example.invalid",
			fetchImpl: fake.fetchImpl as unknown as typeof fetch,
			logFile: tmp,
		});
		await client.call("dns/list");
		await client.flushLogs();
		const contents = await Bun.file(tmp).text();
		expect(contents).toContain("dns/list");
		expect(contents).toContain("[REDACTED]");
		expect(contents).not.toContain("super-secret-token-XYZ");
	});
});
