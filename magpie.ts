import type { Effort, Model, ModelSpec } from "@oh-my-pi/pi-ai";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@oh-my-pi/pi-ai/oauth/types";

export interface MagpieEntry {
	id: string;
	[key: string]: unknown;
}

export type MagpieCredentials = OAuthCredentials & { models: MagpieEntry[] };

const PROVIDER = "magpie-remote";
const EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

export function normalizeMagpieUrl(value: string): string {
	let root = value.trim().replace(/\/+$/, "");
	if (!root) throw new Error("Remote magpie address is required");
	if (!root.includes("://")) root = `http://${root}`;
	for (const suffix of ["/v1/messages", "/v1/chat/completions", "/v1/responses", "/v1"]) {
		if (root.endsWith(suffix)) {
			root = root.slice(0, -suffix.length);
			break;
		}
	}
	return root;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function catalogEntries(value: unknown): MagpieEntry[] {
	if (!isRecord(value) || !Array.isArray(value.data)) {
		throw new Error("invalid model catalog returned by remote magpie");
	}
	return value.data.filter(
		(entry): entry is MagpieEntry =>
			isRecord(entry) &&
			typeof entry.id === "string" &&
			entry.id.length > 0 &&
			!(typeof entry.kind === "string" && entry.kind.length > 0),
	);
}

export async function fetchMagpieCatalog(root: string, key: string, signal?: AbortSignal): Promise<MagpieEntry[]> {
	let response: Response;
	try {
		response = await fetch(`${root}/v1/models`, {
			headers: {
				accept: "application/json",
				...(key ? { Authorization: `Bearer ${key}` } : {}),
			},
			signal,
		});
	} catch (error) {
		if (signal?.aborted) throw error;
		throw new Error(`cannot reach ${root}`, { cause: error });
	}
	if (response.status === 401 || response.status === 403) {
		throw new Error("gateway key rejected (is Share on local network on and the key enabled?)");
	}
	if (!response.ok) throw new Error(`model list request to ${root} failed with HTTP ${response.status}`);
	return catalogEntries(await response.json());
}

function stringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string");
}

function positiveNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function supportedEfforts(levels: readonly string[]): Effort[] {
	return EFFORT_ORDER.filter((effort) => levels.includes(effort)).map((effort) => effort as Effort);
}

export function mapMagpieEntry(entry: MagpieEntry, root: string): ModelSpec {
	const id = entry.id;
	const nativeEndpoints = stringArray(entry.native_endpoints);
	const api = nativeEndpoints.includes("/v1/responses")
		? "openai-responses"
		: nativeEndpoints.includes("/v1/messages")
			? "anthropic-messages"
			: "openai-completions";
	const levels =
		isRecord(entry) && Array.isArray(entry.supported_reasoning_levels)
			? entry.supported_reasoning_levels.flatMap((level) =>
					isRecord(level) && typeof level.effort === "string" ? [level.effort] : [],
				)
			: [];
	const contextWindow = positiveNumber(entry.context_window, positiveNumber(entry.context_length, 128000));
	const maxTokens = Math.min(positiveNumber(entry.max_output_tokens, 16384), contextWindow);
	const modalities = isRecord(entry.modalities) ? stringArray(entry.modalities.input) : [];
	const model: ModelSpec = {
		id,
		name:
			(typeof entry.magpie_label === "string" && entry.magpie_label) ||
			(typeof entry.display_name === "string" && entry.display_name) ||
			id,
		api,
		baseUrl: api === "anthropic-messages" ? root : `${root}/v1`,
		provider: PROVIDER,
		input: modalities.includes("image") ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: entry.reasoning === true || levels.length > 0,
		contextWindow,
		maxTokens,
	};
	if (api !== "anthropic-messages") {
		const efforts = supportedEfforts(levels);
		if (efforts.length > 0) {
			model.thinking = {
				mode: "effort",
				efforts,
				...(levels.includes("none") ? { requiresEffort: false } : {}),
			};
		}
	}
	return model;
}

export function mapMagpieCatalog(entries: unknown, root: string): ModelSpec[] {
	if (!Array.isArray(entries)) return [];
	return entries.flatMap((entry) => {
		if (
			!isRecord(entry) ||
			typeof entry.id !== "string" ||
			entry.id.length === 0 ||
			(typeof entry.kind === "string" && entry.kind.length > 0)
		) {
			return [];
		}
		return [mapMagpieEntry(entry as MagpieEntry, root)];
	});
}

export function projectMagpieModels(models: ModelSpec[], credentials: OAuthCredentials): ModelSpec[] {
	const retained = models.filter((model) => model.provider !== PROVIDER);
	if (
		typeof credentials.apiEndpoint !== "string" ||
		!credentials.apiEndpoint.trim() ||
		!Array.isArray((credentials as MagpieCredentials).models)
	) {
		return retained;
	}
	try {
		const root = normalizeMagpieUrl(credentials.apiEndpoint);
		return [...retained, ...mapMagpieCatalog((credentials as MagpieCredentials).models, root)];
	} catch {
		return retained;
	}
}

export async function loginMagpie(callbacks: OAuthLoginCallbacks): Promise<MagpieCredentials> {
	const address = await callbacks.onPrompt({
		message: "Remote magpie address",
		placeholder: "http://192.168.1.20:3425",
	});
	const root = normalizeMagpieUrl(address);
	const key = await callbacks.onPrompt({
		message: "Gateway key (magpie gateway-key add …)",
		secret: true,
		allowEmpty: true,
	});
	callbacks.onProgress?.("Fetching model list…");
	const models = await fetchMagpieCatalog(root, key, callbacks.signal);
	return {
		access: key,
		refresh: key,
		expires: Date.now() + 10 * 60 * 1000,
		apiEndpoint: root,
		models,
	};
}

export async function refreshMagpieToken(
	credentials: OAuthCredentials,
	signal?: AbortSignal,
): Promise<MagpieCredentials> {
	try {
		const root = typeof credentials.apiEndpoint === "string" ? normalizeMagpieUrl(credentials.apiEndpoint) : "";
		if (!root || typeof credentials.access !== "string") throw new Error("invalid remote magpie credentials");
		const models = await fetchMagpieCatalog(root, credentials.access, signal);
		return { ...credentials, apiEndpoint: root, models, expires: Date.now() + 10 * 60 * 1000 };
	} catch {
		return { ...credentials, expires: Date.now() + 10 * 60 * 1000 } as MagpieCredentials;
	}
}
