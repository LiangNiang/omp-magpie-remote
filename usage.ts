import type { UsageProvider, UsageReport } from "@oh-my-pi/pi-ai";
import { normalizeMagpieUrl } from "./magpie.ts";
import { parseMagpieQuotas, type MagpieQuota, type MagpieQuotaWindow } from "./quota.ts";

const PROVIDER = "magpie-remote";

function quotaTitle(quota: MagpieQuota): string {
	return [quota.provider, quota.plan, quota.user].filter(Boolean).join(" · ");
}

function windowLimit(quota: MagpieQuota, window: MagpieQuotaWindow): UsageReport["limits"][number] {
	const notes = [
		window.display,
		window.used >= 100 ? "exhausted" : undefined,
		quota.error,
	].filter((note): note is string => typeof note === "string" && note.length > 0);
	const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
	return {
		id: `${quota.provider}:${quota.name}:${window.name}`,
		label: `${quotaTitle(quota)} ${window.name}`,
		scope: { provider: PROVIDER, tier: quota.provider },
		window: {
			id: `magpie:${window.name}`,
			label: window.name,
			...(Number.isFinite(resetsAt) ? { resetsAt } : {}),
		},
		amount: window.unlimited
			? { unit: "percent" }
			: { used: window.used, limit: 100, usedFraction: window.used / 100, unit: "percent" },
		status: window.used >= 90 ? "warning" : "ok",
		...(notes.length ? { notes } : {}),
	};
}

export function toUsageReport(quotas: readonly MagpieQuota[], now = Date.now()): UsageReport {
	const limits = quotas.flatMap((quota) => {
		const title = quotaTitle(quota);
		const rows = quota.windows.map((window) => windowLimit(quota, window));
		if (quota.balance) {
			rows.push({
				id: `${quota.provider}:${quota.name}:balance`,
				label: `${title} balance`,
				scope: { provider: PROVIDER, tier: quota.provider },
				amount: { unit: "unknown" },
				status: "ok",
				notes: [`${quota.balance} left`],
			});
		}
		if (quota.error && quota.windows.length === 0 && !quota.balance) {
			rows.push({
				id: `${quota.provider}:${quota.name}:error`,
				label: title,
				scope: { provider: PROVIDER, tier: quota.provider },
				amount: { unit: "unknown" },
				status: "unknown",
				notes: [quota.error],
			});
		}
		return rows;
	});
	return { provider: PROVIDER, fetchedAt: now, limits };
}

export const magpieUsage: UsageProvider = {
	id: PROVIDER,
	cacheVersion: 1,
	supports: (params) => params.credential.type === "oauth" && !!params.credential.apiEndpoint,
	async fetchUsage(params, { fetch }) {
		try {
			const root = normalizeMagpieUrl(params.credential.apiEndpoint ?? "");
			const response = await fetch(`${root}/v1/magpie/quotas`, {
				headers: {
					accept: "application/json",
					Authorization: `Bearer ${params.credential.accessToken ?? ""}`,
				},
				signal: params.signal,
			});
			if (!response.ok) return null;
			return toUsageReport(parseMagpieQuotas(await response.json()));
		} catch {
			return null;
		}
	},
};
