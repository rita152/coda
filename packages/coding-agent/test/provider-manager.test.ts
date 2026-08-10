import { createModels, InMemoryCredentialStore } from "@coda/ai";
import { describe, expect, it, vi } from "vitest";
import { ProviderManager } from "../src/providers/provider-manager.ts";
import { testTimeRuntime } from "./time-runtime.ts";

describe("ProviderManager", () => {
	it("keeps metadata unknown while declaring the conservative Compatibility Mode constraints", async () => {
		const credentials = new InMemoryCredentialStore();
		const models = createModels({ runtime: testTimeRuntime(), credentials });
		const fetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ data: [{ id: "model-a" }] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		const manager = new ProviderManager({ models, fetch });

		const configured = await manager.addCustomProvider({
			providerName: "Acme AI",
			apiProtocol: "openai.responses",
			baseUrl: "https://api.acme.test/v1",
			apiKey: "secret",
		});

		expect(configured).toMatchObject({ id: "custom-acme-ai", discovery: "ready" });
		const runtimeModel = models.getModel("custom-acme-ai", "model-a");
		expect(runtimeModel).toMatchObject({
			api: "openai-responses",
			contextWindow: 16_384,
			maxTokens: 4_096,
		});
		expect(runtimeModel?.cost).toBeUndefined();
		const catalog = manager.catalogModel("custom-acme-ai", "model-a");
		expect(catalog?.metadata).toEqual({
			contextWindow: "unknown",
			maxOutputTokens: "unknown",
			reasoning: "unknown",
			imageInput: "unknown",
			price: "unknown",
		});
		expect(catalog?.compatibility).toEqual({
			contextWindow: 16_384,
			maxOutputTokens: 4_096,
			reasoning: false,
			imageInput: false,
			price: "unreported",
		});
		expect(await models.getAuth("custom-acme-ai")).toMatchObject({ auth: { apiKey: "secret" } });
		expect(fetch).toHaveBeenCalledWith(
			"https://api.acme.test/v1/models",
			expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer secret" }) }),
		);
	});

	it("withdraws runnable models when refresh discovery needs attention", async () => {
		const models = createModels({ runtime: testTimeRuntime(), credentials: new InMemoryCredentialStore() });
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ data: [{ id: "model-a" }] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			)
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

	it("retains a provider that needs attention when discovery fails", async () => {
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

	it("restores cached provider identities and models without network discovery", () => {
		const models = createModels({ runtime: testTimeRuntime(), credentials: new InMemoryCredentialStore() });
		const fetch = vi.fn();
		const manager = new ProviderManager({ models, fetch });

		manager.restore([
			{
				id: "custom-acme-ai",
				name: "Renamed Acme",
				apiProtocol: "openai.chatcompletions",
				baseUrl: "https://api.acme.test/v1",
				discovery: "ready",
				models: [{ id: "cached-model", name: "Cached model" }],
			},
		]);

		expect(manager.configurations).toEqual([expect.objectContaining({ id: "custom-acme-ai", name: "Renamed Acme" })]);
		expect(models.getModel("custom-acme-ai", "cached-model")).toMatchObject({
			api: "openai-completions",
		});
		expect(manager.catalogModel("custom-acme-ai", "cached-model")?.metadata.price).toBe("unknown");
		expect(fetch).not.toHaveBeenCalled();
	});

	it("updates and clears provider credentials through one authority", async () => {
		const models = createModels({ runtime: testTimeRuntime(), credentials: new InMemoryCredentialStore() });
		const manager = new ProviderManager({ models, fetch: vi.fn() });
		manager.restore([
			{
				id: "custom-acme",
				name: "Acme",
				apiProtocol: "openai.responses",
				baseUrl: "https://api.acme.test/v1",
				discovery: "needs_attention",
				models: [],
			},
		]);

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
