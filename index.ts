import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Model } from "@oh-my-pi/pi-ai";
import { loginMagpie, mapMagpieCatalog, normalizeMagpieUrl, projectMagpieModels, refreshMagpieToken } from "./magpie.ts";
import {
	fetchMagpieQuotas,
	formatQuotaStatus,
	mostUsed,
	quotasForModel,
	type MagpieQuota,
} from "./quota.ts";
import { magpieUsage } from "./usage.ts";

const PROVIDER = "magpie-remote";
const STATUS_KEY = "magpie-quota";
const QUOTA_TTL_MS = 60_000;

export default function (pi: ExtensionAPI): void {
	pi.registerProvider(PROVIDER, {
		baseUrl: "http://127.0.0.1:3425/v1",
		api: "openai-completions",
		models: [
			{
				id: "magpie-remote-login",
				name: "Magpie (remote) — run /login",
				api: "openai-completions",
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				reasoning: false,
				contextWindow: 128000,
				maxTokens: 16384,
			},
		],
		usage: magpieUsage,
		oauth: {
			name: "Magpie (remote)",
			login: loginMagpie,
			refreshToken: refreshMagpieToken,
			getApiKey: (credentials) => credentials.access,
			modifyModels: (models, credentials) =>
				projectMagpieModels(models, credentials) as Model[],
		},
	});

	let cached: { at: number; quotas: MagpieQuota[] } | undefined;
	let pending: Promise<MagpieQuota[]> | undefined;

	async function loadQuotas(ctx: ExtensionContext, force: boolean): Promise<MagpieQuota[]> {
		if (!force && cached && Date.now() - cached.at < QUOTA_TTL_MS) return cached.quotas;
		pending ??= (async () => {
			const credential = ctx.modelRegistry.authStorage.credentials.getOAuth(PROVIDER);
			if (!credential || typeof credential.apiEndpoint !== "string") {
				throw new Error("not logged in to Magpie (remote) — run /login first");
			}
			const root = normalizeMagpieUrl(credential.apiEndpoint);
			const key = credential.access ?? (await ctx.modelRegistry.getApiKeyForProvider(PROVIDER)) ?? "";
			const quotas = await fetchMagpieQuotas(root, key, AbortSignal.timeout(20_000));
			cached = { at: Date.now(), quotas };
			return quotas;
		})()
			.catch((error: unknown) => {
				cached = undefined;
				throw error;
			})
			.finally(() => {
				pending = undefined;
			});
		return pending;
	}

	async function updateStatus(ctx: ExtensionContext, force = false): Promise<void> {
		if (!ctx.hasUI) return;
		const model = ctx.model;
		if (model?.provider !== PROVIDER) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		let quotas: MagpieQuota[];
		try {
			quotas = quotasForModel(await loadQuotas(ctx, force), model.id);
		} catch {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		if (ctx.model?.provider !== PROVIDER || ctx.model.id !== model.id) return;
		const [first] = quotas;
		if (!first) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const used = mostUsed(first) ?? 0;
		const color = first.error ? "muted" : used >= 90 ? "error" : used >= 75 ? "warning" : "dim";
		const more = quotas.length > 1 ? ` +${quotas.length - 1}` : "";
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(color, formatQuotaStatus(first) + more));
	}

	pi.on("session_start", (_event, ctx) => void updateStatus(ctx));
	pi.on("turn_start", (_event, ctx) => void updateStatus(ctx));
	pi.on("agent_end", (_event, ctx) => void updateStatus(ctx));
}
