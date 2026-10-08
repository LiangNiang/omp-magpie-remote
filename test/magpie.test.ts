import { describe, expect, test } from "bun:test";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai";
import type { ModelSpec } from "@oh-my-pi/pi-ai";
import {
	loginMagpie,
	mapMagpieCatalog,
	mapMagpieEntry,
	normalizeMagpieUrl,
	projectMagpieModels,
	refreshMagpieToken,
	type MagpieCredentials,
} from "../magpie.ts";

const ROOT = "http://127.0.0.1:3425";

describe("normalizeMagpieUrl", () => {
	test("accepts host names and strips API paths", () => {
		expect(normalizeMagpieUrl("192.168.1.20:3425/v1/")).toBe("http://192.168.1.20:3425");
		expect(normalizeMagpieUrl("https://magpie.example/v1/messages")).toBe("https://magpie.example");
	});

	test("rejects an empty address", () => {
		expect(() => normalizeMagpieUrl("  ")).toThrow("address is required");
	});
});

describe("mapMagpieEntry", () => {
	test("maps OpenAI responses models and intersects reasoning efforts in canonical order", () => {
		const model = mapMagpieEntry(
			{
				id: "codex/gpt-5",
				magpie_label: "GPT 5",
				native_endpoints: ["/v1/responses"],
				context_window: 200000,
				max_output_tokens: 30000,
				modalities: { input: ["text", "image"] },
				reasoning: false,
				supported_reasoning_levels: [
					{ effort: "high" },
					{ effort: "none" },
					{ effort: "xhigh" },
					{ effort: "unsupported" },
				],
			},
			ROOT,
		);
		expect(model).toMatchObject({
			id: "codex/gpt-5",
			name: "GPT 5",
			api: "openai-responses",
			baseUrl: `${ROOT}/v1`,
			provider: "magpie-remote",
			input: ["text", "image"],
			contextWindow: 200000,
			maxTokens: 30000,
			reasoning: true,
			thinking: { mode: "effort", efforts: ["high", "xhigh"], requiresEffort: false },
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
	});

	test("routes Anthropic models to the root and leaves thinking inference to omp", () => {
		const model = mapMagpieEntry(
			{
				id: "claude-sonnet-4",
				native_endpoints: ["/v1/messages"],
				supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
			},
			ROOT,
		);
		expect(model.api).toBe("anthropic-messages");
		expect(model.baseUrl).toBe(ROOT);
		expect(model.reasoning).toBe(true);
		expect(model.thinking).toBeUndefined();
	});

	test("uses completions by default and omits thinking without supported efforts", () => {
		const model = mapMagpieEntry(
			{
				id: "api/model",
				display_name: "Model",
				supported_reasoning_levels: [{ effort: "none" }, { effort: "unsupported" }],
			},
			ROOT,
		);
		expect(model.api).toBe("openai-completions");
		expect(model.name).toBe("Model");
		expect(model.thinking).toBeUndefined();
		expect(model.reasoning).toBe(true);
	});

	test("skips non-model catalog entries", () => {
		expect(
			mapMagpieCatalog(
				[
					{ id: "valid" },
					{ id: "hidden", kind: "alias" },
					{ kind: "group" },
				],
				ROOT,
			).map((model) => model.id),
		).toEqual(["valid"]);
	});
});

describe("projectMagpieModels", () => {
	const otherModel = {
		id: "other-model",
		name: "Other",
		api: "openai-completions",
		provider: "other",
		baseUrl: "http://other/v1",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: false,
		contextWindow: 1000,
		maxTokens: 100,
	} satisfies ModelSpec;
	const bootstrap = { ...otherModel, id: "magpie-remote-login", provider: "magpie-remote" };

	test("replaces Magpie bootstrap rows and retains other providers", () => {
		const result = projectMagpieModels(
			[otherModel, bootstrap] as Parameters<typeof projectMagpieModels>[0],
			{
				access: "key",
				refresh: "key",
				expires: 0,
				apiEndpoint: ROOT,
				models: [{ id: "responses-model", native_endpoints: ["/v1/responses"] }],
			} as MagpieCredentials,
		);
		expect(result.map((model) => [model.provider, model.id])).toEqual([
			["other", "other-model"],
			["magpie-remote", "responses-model"],
		]);
	});

	test("drops existing Magpie rows for invalid credentials", () => {
		const result = projectMagpieModels(
			[otherModel, bootstrap] as Parameters<typeof projectMagpieModels>[0],
			{
				access: "key",
				refresh: "key",
				expires: 0,
				apiEndpoint: "",
				models: [{ id: "ignored" }],
			} as MagpieCredentials,
		);
		expect(result).toEqual([otherModel]);
	});
});

describe("loginMagpie and refreshMagpieToken", () => {
	test("prompts for address and secret key, then stores endpoint and catalog", async () => {
		const server = Bun.serve({
			port: 0,
			fetch: (request) => {
				expect(new URL(request.url).pathname).toBe("/v1/models");
				expect(request.headers.get("authorization")).toBe("Bearer gateway-key");
				return Response.json({ data: [{ id: "remote-model" }] });
			},
		});
		const prompts: Array<Record<string, unknown>> = [];
		const callbacks = {
			onPrompt: async (prompt: Record<string, unknown>) => {
				prompts.push(prompt);
				return prompt.secret ? "gateway-key" : `http://127.0.0.1:${server.port}/v1`;
			},
			onProgress: () => {},
			signal: new AbortController().signal,
		} as unknown as Parameters<typeof loginMagpie>[0];
		try {
			const credential = await loginMagpie(callbacks);
			expect(credential).toMatchObject({
				access: "gateway-key",
				refresh: "gateway-key",
				apiEndpoint: `http://127.0.0.1:${server.port}`,
				models: [{ id: "remote-model" }],
			});
			expect(credential.expires).toBeGreaterThan(Date.now());
			expect(prompts).toEqual([
				{ message: "Remote magpie address", placeholder: "http://192.168.1.20:3425" },
				{ message: "Gateway key (magpie gateway-key add …)", secret: true, allowEmpty: true },
			]);
		} finally {
			server.stop(true);
		}
	});

	test("refreshes the model snapshot and extends expiry", async () => {
		const server = Bun.serve({
			port: 0,
			fetch: () => Response.json({ data: [{ id: "updated-model" }] }),
		});
		try {
			const refreshed = await refreshMagpieToken(
				{
					access: "key",
					refresh: "key",
					expires: 1,
					apiEndpoint: `http://127.0.0.1:${server.port}`,
					models: [{ id: "old-model" }],
				} as OAuthCredentials,
			);
			expect(refreshed.models).toEqual([{ id: "updated-model" }]);
			expect(refreshed.expires).toBeGreaterThan(Date.now());
		} finally {
			server.stop(true);
		}
	});

	test("preserves credentials and extends expiry when catalog refresh fails", async () => {
		const credentials = {
			access: "key",
			refresh: "key",
			expires: 1,
			apiEndpoint: "http://127.0.0.1:1",
			models: [{ id: "cached-model" }],
		} as OAuthCredentials;
		const refreshed = await refreshMagpieToken(credentials);
		expect(refreshed.models).toEqual([{ id: "cached-model" }]);
		expect(refreshed.access).toBe("key");
		expect(refreshed.apiEndpoint).toBe("http://127.0.0.1:1");
		expect(refreshed.expires).toBeGreaterThan(Date.now());
	});
});
