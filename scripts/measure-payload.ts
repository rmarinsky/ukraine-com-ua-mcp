#!/usr/bin/env bun
/**
 * Run a real `dns/list` against the live API, then encode the response three
 * ways (full JSON, lean JSON, lean TOON) so we can eyeball the byte-count diff.
 * No tokens — bytes are a good-enough proxy and don't require a tokenizer dep.
 */
import { AdmToolsClient } from "../src/admtools.js";
import { applyProjection, encodeForLlm } from "../src/llm-encode.js";
import { paginate } from "../src/paginate.js";
import { DOMAIN_LIST_LEAN } from "../src/projections.js";

const token = process.env.ADM_TOOLS_TOKEN;
if (!token) {
	console.error("ADM_TOOLS_TOKEN required");
	process.exit(1);
}

const client = new AdmToolsClient({ token });
const domains = await client.listDomains();
const page = paginate(domains, { limit: 50 });

const fullPayload = { total: page.total, domains: page.items };
const leanPayload = {
	total: page.total,
	domains: applyProjection(page.items, DOMAIN_LIST_LEAN),
};
const fullJsonText = JSON.stringify(fullPayload, null, 2);
const leanJsonText = JSON.stringify(leanPayload, null, 2);
const leanToonText = encodeForLlm(leanPayload);
const fullToonText = encodeForLlm(fullPayload);

console.log(`# domains in account: ${domains.length}`);
console.log(`# domains on this page: ${page.items.length}`);
console.log("");
console.log(`full JSON:        ${fullJsonText.length.toString().padStart(7)} bytes  (current 0.1.x baseline)`);
console.log(`full TOON:        ${fullToonText.length.toString().padStart(7)} bytes  (verbose: true)`);
console.log(`lean JSON:        ${leanJsonText.length.toString().padStart(7)} bytes  (format: "json")`);
console.log(`lean TOON:        ${leanToonText.length.toString().padStart(7)} bytes  (default 0.2.0)`);
console.log("");
const fullVsLeanJson = (1 - leanJsonText.length / fullJsonText.length) * 100;
const leanJsonVsToon = (1 - leanToonText.length / leanJsonText.length) * 100;
const fullVsToon = (1 - leanToonText.length / fullJsonText.length) * 100;
console.log(`projection alone: -${fullVsLeanJson.toFixed(1)}% bytes`);
console.log(`TOON over lean:   -${leanJsonVsToon.toFixed(1)}% bytes`);
console.log(`combined:         -${fullVsToon.toFixed(1)}% bytes`);
console.log("");
console.log("--- TOON sample (first 600 chars) ---");
console.log(leanToonText.slice(0, 600));
