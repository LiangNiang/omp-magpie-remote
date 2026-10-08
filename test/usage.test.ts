import { describe, expect, test } from "bun:test";
import type { UsageProvider } from "@oh-my-pi/pi-ai";
import { magpieUsage, toUsageReport } from "../usage.ts";
import { parseMagpieQuotas } from "../quota.ts";

describe("toUsageReport", () => {
	test("maps windows without usage window scopes or durations and never exhausts a limit", () => {
		const [quota] = parseMagpieQuotas({
			data: [
				{
					provider: "codex",
					name: "primary",
					plan: "Plus",
					user: "user@example.com",
					windows: [
						{ name: "5h", used: 93, display: "2h left", resetsAt: "2026-10-11T12:00:00Z" },
						{ name: "weekly", used: 100 },
						{ name: "daily", unlimited: true },
					],
					error: "quota warning",
				},
			],
		});
		const report = toUsageReport([quota!], 1234);
		expect(report).toEqual({
			provider: "magpie-remote",
			fetchedAt: 1234,
			limits: [
				{
					id: "codex:primary:5h",
					label: "codex · Plus · user@example.com 5h",
					scope: { provider: "magpie-remote", tier: "codex" },
					window: { id: "magpie:5h", label: "5h", resetsAt: Date.parse("2026-10-11T12:00:00Z") },
					amount: { used: 93, limit: 100, usedFraction: 0.93, unit: "percent" },
					status: "warning",
					notes: ["2h left", "quota warning"],
				},
				{
					id: "codex:primary:weekly",
					label: "codex · Plus · user@example.com weekly",
					scope: { provider: "magpie-remote", tier: "codex" },
					window: { id: "magpie:weekly", label: "weekly" },
					amount: { used: 100, limit: 100, usedFraction: 1, unit: "percent" },
					status: "warning",
					notes: ["exhausted", "quota warning"],
				},
				{
					id: "codex:primary:daily",
					label: "codex · Plus · user@example.com daily",
					scope: { provider: "magpie-remote", tier: "codex" },
					window: { id: "magpie:daily", label: "daily" },
					amount: { unit: "percent" },
					status: "ok",
					notes: ["quota warning"],
				},
			],
		});
		for (const limit of report.limits) {
			expect(limit.scope).not.toHaveProperty("windowId");
			expect(limit.window).not.toHaveProperty("durationMs");
			expect(limit.status).not.toBe("exhausted");
		}
	});

	test("creates balance and error-only rows", () => {
		const quotas = parseMagpieQuotas({
			data: [
				{ provider: "deepseek", name: "key", kind: "key", balance: "¥12.30" },
				{ provider: "anthropic", name: "account", error: "upstream unavailable" },
			],
		});
		expect(toUsageReport(quotas, 0).limits).toEqual([
			{
				id: "deepseek:key:balance",
				label: "deepseek balance",
				scope: { provider: "magpie-remote", tier: "deepseek" },
				amount: { unit: "unknown" },
				status: "ok",
				notes: ["¥12.30 left"],
			},
			{
				id: "anthropic:account:error",
				label: "anthropic",
				scope: { provider: "magpie-remote", tier: "anthropic" },
				amount: { unit: "unknown" },
				status: "unknown",
				notes: ["upstream unavailable"],
			},
		]);
	});
});

describe("magpieUsage", () => {
	test("supports only OAuth credentials with an endpoint", () => {
		expect(magpieUsage.supports?.({ provider: "magpie-remote", credential: { type: "oauth", apiEndpoint: "http://x" } })).toBe(
			true,
		);
		expect(magpieUsage.supports?.({ provider: "magpie-remote", credential: { type: "oauth" } })).toBe(false);
		expect(magpieUsage.supports?.({ provider: "magpie-remote", credential: { type: "api_key" } })).toBe(false);
	});

	test("sends the bearer token and returns null when rejected", async () => {
		const auth = { value: null as string | null };
		const params = {
			provider: "magpie-remote",
			credential: {
				type: "oauth",
				apiEndpoint: "http://magpie.local",
				accessToken: "gateway-key",
			},
			signal: new AbortController().signal,
		} as Parameters<UsageProvider["fetchUsage"]>[0];
		const report = await magpieUsage.fetchUsage(params, {
			fetch: async (input, init) => {
				expect(input).toBe("http://magpie.local/v1/magpie/quotas");
				auth.value = new Headers(init?.headers).get("authorization");
				return Response.json({ data: [{ provider: "codex", windows: [{ name: "5h", used: 12 }] }] });
			},
		});
		expect(auth.value).toBe("Bearer gateway-key");
		expect(report?.provider).toBe("magpie-remote");
		expect(report?.limits).toHaveLength(1);

		const rejected = await magpieUsage.fetchUsage(params, {
			fetch: async () => new Response("unauthorized", { status: 401 }),
		});
		expect(rejected).toBeNull();
	});
});
