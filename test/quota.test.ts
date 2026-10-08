import { describe, expect, test } from "bun:test";
import {
	formatQuotaReport,
	formatQuotaStatus,
	mostUsed,
	parseMagpieQuotas,
	quotasForModel,
	resetClock,
	shortWindowName,
} from "../quota.ts";

const quotas = [
	{
		provider: "codex",
		name: "primary",
		kind: "subscription",
		plan: "Plus",
		user: "me@example.com",
		windows: [
			{ name: "5h", used: 36 },
			{ name: "weekly", used: 74, display: "3d 2h", resetsAt: "2026-10-12T14:30:00Z" },
			{ name: "daily", used: 100, unlimited: true },
		],
	},
	{
		provider: "codex",
		name: "last",
		kind: "subscription",
		windows: [{ name: "5h", used: 82 }],
		last: true,
	},
];

describe("parseMagpieQuotas", () => {
	test("parses quota rows and ignores malformed entries", () => {
		expect(
			parseMagpieQuotas({
				data: [
					{ provider: "codex", windows: [{ name: "5h", used: 25 }] },
					{ windows: [] },
				],
			}),
		).toEqual([
			{
				provider: "codex",
				name: "codex",
				kind: "subscription",
				plan: undefined,
				user: undefined,
				windows: [{ name: "5h", used: 25, unlimited: undefined, resetsAt: undefined, display: undefined }],
				balance: undefined,
				error: undefined,
				resets: undefined,
				last: undefined,
			},
		]);
		expect(() => parseMagpieQuotas({})).toThrow("invalid quota list");
	});
});

describe("quota display helpers", () => {
	test("shortens known window periods", () => {
		expect(shortWindowName("weekly")).toBe("1w");
		expect(shortWindowName("24 hours")).toBe("24h");
		expect(shortWindowName("monthly")).toBe("1mo");
		expect(shortWindowName("custom")).toBe("custom");
	});

	test("sorts the most recently served account first", () => {
		expect(quotasForModel(quotas, "codex/gpt-5").map((quota) => quota.name)).toEqual(["last", "primary"]);
		expect(quotasForModel(quotas, "deepseek/v3")).toEqual([]);
	});

	test("formats a compact status and shows the most used windows", () => {
		expect(mostUsed(quotas[0]!)).toBe(74);
		expect(formatQuotaStatus(quotas[0]!)).toBe("codex 5h 36% · 1w 74%");
		expect(formatQuotaStatus({ ...quotas[0]!, windows: [], balance: "¥12.30" })).toBe("codex ¥12.30");
	});

	test("formats reset times and quota report", () => {
		const now = new Date("2026-10-10T12:00:00Z");
		expect(resetClock(new Date("2026-10-11T14:30:00Z"), now)).toBe("tomorrow 14:30");
		expect(formatQuotaReport(quotas, now)).toContain("codex · Plus · me@example.com");
		expect(formatQuotaReport([])).toContain("no subscription");
	});
});
