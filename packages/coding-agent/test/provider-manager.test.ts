import { createModels, InMemoryCredentialStore } from "@coda/ai";
import { describe, expect, it, vi } from "vitest";
import { ProviderManager } from "../src/providers/provider-manager.ts";
import type { CustomProviderConfig, CustomProviderModelConfig } from "../src/providers/types.ts";
import { effectiveReasoningEffort } from "../src/reasoning-effort.ts";
import { testTimeRuntime } from "./time-runtime.ts";

const USER_PRICE = {
	input: 1,
	output: 2,
	cacheRead: 0.1,
	cacheWrite: 1.25,
};

describe("ProviderManager", () => {
	it("uses source-labelled capabilities explicitly returned by Provider discovery", async () => {
		const credentials = new InMemoryCredentialStore();
		const models = createModels({ runtime: testTimeRuntime(), credentials });
		const fetch = vi.fn(async () =>
			modelResponse([
				{
					id: "model-a",
					name: "Model A",
					context_window: 128_000,
					max_output_tokens: 16_384,
					supports_reasoning: true,
					architecture: { input_modalities: ["text", "image"] },
					price: USER_PRICE,
				},
			]),
		);
		const manager = new ProviderManager({ models, fetch });

		const configured = await manager.addCustomProvider({
			providerName: "Acme AI",
			apiProtocol: "openai.responses",
			baseUrl: "https://api.acme.test/v1",
			apiKey: "secret",
		});

		expect(configured).toMatchObject({
			id: "custom-acme-ai",
			discovery: "ready",
			models: [
				{
					id: "model-a",
					name: "Model A",
					contextWindow: { source: "provider", value: 128_000 },
					maxTokens: { source: "provider", value: 16_384 },
					reasoning: { source: "provider", value: true },
					input: { source: "provider", value: ["text", "image"] },
					price: { source: "provider", value: USER_PRICE },
				},
			],
		});
		const runtimeModel = models.getModel("custom-acme-ai", "model-a");
		expect(runtimeModel).toMatchObject({
			api: "openai-responses",
			contextWindow: 128_000,
			maxTokens: 16_384,
			reasoning: true,
			input: ["text", "image"],
			cost: USER_PRICE,
		});
		expect(manager.catalogModel("custom-acme-ai", "model-a")?.metadata).toEqual({
			contextWindow: { source: "provider", value: 128_000 },
			maxOutputTokens: { source: "provider", value: 16_384 },
			reasoning: { source: "provider", value: true },
			input: { source: "provider", value: ["text", "image"] },
			price: { source: "provider", value: USER_PRICE },
		});
		expect(JSON.stringify(configured)).not.toContain("secret");
		expect(await models.getAuth("custom-acme-ai")).toMatchObject({ auth: { apiKey: "secret" } });
		expect(fetch).toHaveBeenCalledWith(
			"https://api.acme.test/v1/models",
			expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer secret" }) }),
		);
	});

	it("keeps undisclosed and invalid fields unknown without inferring from the Model name", async () => {
		const models = createModels({ runtime: testTimeRuntime(), credentials: new InMemoryCredentialStore() });
		const manager = new ProviderManager({
			models,
			fetch: vi.fn(async () =>
				modelResponse([
					{
						id: "vision-reasoner-1m-32k",
						context_window: 0,
						max_output_tokens: -1,
						reasoning: "true",
						input_modalities: ["image"],
						price: { input: 1, output: 2 },
					},
				]),
			),
		});

		await manager.addCustomProvider({
			providerName: "Unknown",
			apiProtocol: "openai.chatcompletions",
			baseUrl: "https://unknown.test/v1",
			apiKey: "secret",
		});

		expect(models.getModel("custom-unknown", "vision-reasoner-1m-32k")).toMatchObject({
			contextWindow: 16_384,
			maxTokens: 4_096,
			reasoning: false,
			input: ["text"],
		});
		expect(models.getModel("custom-unknown", "vision-reasoner-1m-32k")?.cost).toBeUndefined();
		expect(manager.catalogModel("custom-unknown", "vision-reasoner-1m-32k")?.metadata).toEqual({
			contextWindow: { source: "compatibility", value: 16_384 },
			maxOutputTokens: { source: "compatibility", value: 4_096 },
			reasoning: { source: "compatibility", value: false },
			input: { source: "compatibility", value: ["text"] },
			price: { source: "compatibility", value: "unreported" },
		});
	});

	it("preserves explicit user overrides while refreshing Provider-owned fields", async () => {
		const models = createModels({ runtime: testTimeRuntime(), credentials: new InMemoryCredentialStore() });
		const manager = new ProviderManager({
			models,
			fetch: vi.fn(async () =>
				modelResponse([
					{
						id: "model-a",
						contextWindow: 128_000,
						maxTokens: 16_384,
						reasoning: false,
						input: ["text"],
						price: { input: 8, output: 16, cacheRead: 4, cacheWrite: 10 },
					},
				]),
			),
		});
		manager.restore([
			providerConfig([
				{
					id: "model-a",
					name: "Configured Model",
					contextWindow: { source: "user", value: 64_000 },
					maxTokens: { source: "provider", value: 8_192 },
					reasoning: { source: "user", value: true },
					input: { source: "user", value: ["text", "image"] },
					price: { source: "user", value: USER_PRICE },
				},
			]),
		]);
		await manager.updateApiKey("custom-acme", "new-secret", { discover: false });

		const refreshed = await manager.refresh("custom-acme");

		expect(refreshed?.models[0]).toMatchObject({
			contextWindow: { source: "user", value: 64_000 },
			maxTokens: { source: "provider", value: 16_384 },
			reasoning: { source: "user", value: true },
			input: { source: "user", value: ["text", "image"] },
			price: { source: "user", value: USER_PRICE },
		});
		expect(models.getModel("custom-acme", "model-a")).toMatchObject({
			contextWindow: 64_000,
			maxTokens: 16_384,
			reasoning: true,
			input: ["text", "image"],
			cost: USER_PRICE,
		});
	});

	it("replaces omitted Provider metadata with field-level Compatibility Mode on refresh", async () => {
		const models = createModels({ runtime: testTimeRuntime(), credentials: new InMemoryCredentialStore() });
		const manager = new ProviderManager({ models, fetch: vi.fn(async () => modelResponse([{ id: "model-a" }])) });
		manager.restore([
			providerConfig([
				{
					id: "model-a",
					name: "Model A",
					contextWindow: { source: "provider", value: 128_000 },
					maxTokens: { source: "user", value: 8_192 },
				},
			]),
		]);
		await manager.updateApiKey("custom-acme", "secret", { discover: false });

		await manager.refresh("custom-acme");

		expect(manager.catalogModel("custom-acme", "model-a")?.metadata).toMatchObject({
			contextWindow: { source: "compatibility", value: 16_384 },
			maxOutputTokens: { source: "user", value: 8_192 },
		});
		expect(models.getModel("custom-acme", "model-a")).toMatchObject({
			contextWindow: 16_384,
			maxTokens: 8_192,
		});
	});

	it("retains disappeared Models as durably stale with their exact metadata", async () => {
		const models = createModels({ runtime: testTimeRuntime(), credentials: new InMemoryCredentialStore() });
		const manager = new ProviderManager({
			models,
			fetch: vi.fn(async () => modelResponse([{ id: "model-a", contextWindow: 96_000 }])),
		});
		manager.restore([
			providerConfig([
				{ id: "model-a", name: "Model A", contextWindow: { source: "provider", value: 64_000 } },
				{
					id: "model-b",
					name: "Model B",
					contextWindow: { source: "user", value: 32_000 },
					reasoning: { source: "user", value: true },
				},
			]),
		]);
		await manager.updateApiKey("custom-acme", "secret", { discover: false });

		const refreshed = await manager.refresh("custom-acme");

		expect(refreshed?.models).toContainEqual(
			expect.objectContaining({
				id: "model-b",
				stale: true,
				contextWindow: { source: "user", value: 32_000 },
				reasoning: { source: "user", value: true },
			}),
		);
		expect(manager.catalogModel("custom-acme", "model-b")?.stale).toBe(true);

		const restoredModels = createModels({
			runtime: testTimeRuntime(),
			credentials: new InMemoryCredentialStore(),
		});
		const restoredManager = new ProviderManager({ models: restoredModels, fetch: vi.fn() });
		restoredManager.restore([refreshed!]);
		expect(restoredManager.catalogModel("custom-acme", "model-b")).toMatchObject({
			stale: true,
			metadata: {
				contextWindow: { source: "user", value: 32_000 },
				reasoning: { source: "user", value: true },
			},
		});
	});

	it("switches every runtime consumer to the selected Model's resolved metadata", () => {
		const models = createModels({ runtime: testTimeRuntime(), credentials: new InMemoryCredentialStore() });
		const manager = new ProviderManager({ models, fetch: vi.fn() });
		manager.restore([
			providerConfig([
				{ id: "text", name: "Text" },
				{
					id: "vision",
					name: "Vision",
					contextWindow: { source: "user", value: 80_000 },
					maxTokens: { source: "user", value: 20_000 },
					reasoning: { source: "user", value: true },
					input: { source: "user", value: ["text", "image"] },
					price: { source: "user", value: USER_PRICE },
				},
			]),
		]);
		const text = models.getModel("custom-acme", "text")!;
		const vision = models.getModel("custom-acme", "vision")!;

		expect(text.maxTokens).toBe(4_096);
		expect(vision.maxTokens).toBe(20_000);
		expect(text.input.includes("image")).toBe(false);
		expect(vision.input.includes("image")).toBe(true);
		expect(effectiveReasoningEffort(text, "high")).toBe("off");
		expect(effectiveReasoningEffort(vision, "high")).toBe("high");
		expect(text.cost).toBeUndefined();
		expect(vision.cost).toEqual(USER_PRICE);
	});

	it("rejects impossible explicit bounds instead of clamping or guessing", () => {
		const models = createModels({ runtime: testTimeRuntime(), credentials: new InMemoryCredentialStore() });
		const manager = new ProviderManager({ models, fetch: vi.fn() });

		expect(() =>
			manager.restore([
				providerConfig([
					{
						id: "invalid",
						name: "Invalid",
						contextWindow: { source: "user", value: 8_192 },
						maxTokens: { source: "user", value: 16_384 },
					},
				]),
			]),
		).toThrow("maxTokens must not exceed contextWindow");
	});

	it("withdraws runnable Models when refresh discovery needs attention", async () => {
		const models = createModels({ runtime: testTimeRuntime(), credentials: new InMemoryCredentialStore() });
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(modelResponse([{ id: "model-a" }]))
			.mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
		const manager = new ProviderManager({ models, fetch });
		await manager.addCustomProvider({
			providerName: "Acme",
			apiProtocol: "openai.responses",
			baseUrl: "https://api.acme.test/v1",
			apiKey: "secret",
		});
		expect(models.getModels("custom-acme")).toHaveLength(1);

		const refreshed = await manager.refresh("custom-acme");

		expect(refreshed).toMatchObject({ discovery: "needs_attention", models: [{ id: "model-a" }] });
		expect(models.getModels("custom-acme")).toEqual([]);
		expect(manager.catalogModel("custom-acme", "model-a")).toBeUndefined();
	});

	it("retains a Provider that needs attention when discovery fails", async () => {
		const models = createModels({ runtime: testTimeRuntime(), credentials: new InMemoryCredentialStore() });
		const manager = new ProviderManager({
			models,
			fetch: vi.fn(async () => new Response("unavailable", { status: 503 })),
		});

		const configured = await manager.addCustomProvider({
			providerName: "Offline",
			apiProtocol: "anthropic.messages",
			baseUrl: "https://offline.test/v1/",
			apiKey: "kept-secret",
		});

		expect(configured).toMatchObject({
			id: "custom-offline",
			baseUrl: "https://offline.test/v1",
			discovery: "needs_attention",
			models: [],
		});
		expect(models.getProvider("custom-offline")).toBeDefined();
		expect(models.getModels("custom-offline")).toEqual([]);
		expect(await models.getAuth("custom-offline")).toMatchObject({ auth: { apiKey: "kept-secret" } });
	});

	it("restores cached Provider identities and metadata without network discovery", () => {
		const models = createModels({ runtime: testTimeRuntime(), credentials: new InMemoryCredentialStore() });
		const fetch = vi.fn();
		const manager = new ProviderManager({ models, fetch });

		manager.restore([
			{
				...providerConfig([
					{
						id: "cached-model",
						name: "Cached Model",
						contextWindow: { source: "provider", value: 100_000 },
					},
				]),
				id: "custom-acme-ai",
				name: "Renamed Acme",
				apiProtocol: "openai.chatcompletions",
			},
		]);

		expect(manager.configurations).toEqual([expect.objectContaining({ id: "custom-acme-ai", name: "Renamed Acme" })]);
		expect(models.getModel("custom-acme-ai", "cached-model")).toMatchObject({
			api: "openai-completions",
			contextWindow: 100_000,
		});
		expect(manager.catalogModel("custom-acme-ai", "cached-model")?.metadata.price).toEqual({
			source: "compatibility",
			value: "unreported",
		});
		expect(fetch).not.toHaveBeenCalled();
	});

	it("updates and clears Provider Credentials through one authority", async () => {
		const models = createModels({ runtime: testTimeRuntime(), credentials: new InMemoryCredentialStore() });
		const manager = new ProviderManager({ models, fetch: vi.fn() });
		manager.restore([{ ...providerConfig([]), discovery: "needs_attention" }]);

		await manager.updateApiKey("custom-acme", "new-secret", { discover: false });
		expect(await manager.authenticationEntries()).toContainEqual({
			id: "custom-acme",
			name: "Acme",
			configured: true,
		});

		await manager.logout("custom-acme");
		expect(await models.getAuth("custom-acme")).toBeUndefined();
	});
});

function providerConfig(models: readonly CustomProviderModelConfig[]): CustomProviderConfig {
	return {
		id: "custom-acme",
		name: "Acme",
		apiProtocol: "openai.responses" as const,
		baseUrl: "https://api.acme.test/v1",
		discovery: "ready" as const,
		models,
	};
}

function modelResponse(data: readonly unknown[]): Response {
	return new Response(JSON.stringify({ data }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}
