import { describe, expect, test } from "bun:test";
import { mapMagpieCatalog, normalizeMagpieUrl } from "../magpie.ts";
import { fetchMagpieQuotas } from "../quota.ts";
import { toUsageReport } from "../usage.ts";

const gateway = process.env.MAGPIE_URL;
const key = process.env.MAGPIE_GATEWAY_KEY;

describe("read-only Magpie smoke test", () => {
	test.skipIf(!gateway || !key)("catalog, API authentication, and quota usage report", async () => {
		const root = normalizeMagpieUrl(gateway!);
		const headers = { accept: "application/json", authorization: `Bearer ${key}` };
		const modelsResponse = await fetch(`${root}/v1/models`, { headers });
		expect(modelsResponse.status).not.toBe(401);
		expect(modelsResponse.status).not.toBe(403);
		expect(modelsResponse.ok).toBe(true);
		const modelsPayload: unknown = await modelsResponse.json();
		const models = mapMagpieCatalog(
			modelsPayload && typeof modelsPayload === "object" && "data" in modelsPayload
				? modelsPayload.data
				: [],
			root,
		);
		expect(models.length).toBeGreaterThan(0);

		const endpoints = new Set(models.map((model) => model.api));
		for (const api of endpoints) {
			const path =
				api === "anthropic-messages"
					? "/v1/messages"
					: api === "openai-responses"
						? "/v1/responses"
						: "/v1/chat/completions";
			const response = await fetch(`${root}${path}`, {
				method: "POST",
				headers: {
					...headers,
					...(api === "anthropic-messages"
						? { "x-api-key": key!, "anthropic-version": "2023-06-01" }
						: {}),
					"content-type": "application/json",
				},
				body: "{}",
			});
			expect(response.status).not.toBe(401);
			expect(response.status).not.toBe(403);
			await response.body?.cancel();
		}

		const quotas = await fetchMagpieQuotas(root, key!);
		const report = toUsageReport(quotas);
		expect(report.limits.length).toBeGreaterThan(0);
	});
});
