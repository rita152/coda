// Portions derived from Pi:
// /packages/ai/test/models-runtime.test.ts @ 958c13f25080b59d4b736193f972a8502a7a2f8b
// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
// See THIRD_PARTY_NOTICES.md.

import { describe, expect, test } from "vitest";
import type { AssistantMessage, Model, ProviderStreams, SimpleStreamOptions } from "../src/index.ts";
import {
	AssistantMessageEventStream,
	createModels,
	createProvider,
	envApiKeyAuth,
	InMemoryCredentialStore,
} from "../src/index.ts";
import { testTimeRuntime } from "./time-runtime.ts";

const testModel: Model<"openai-completions"> = {
	id: "test-model",
	name: "Test Model",
	api: "openai-completions",
	provider: "opencode-go",
	baseUrl: "https://example.test/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10_000,
	maxTokens: 1_000,
};

function successfulStreams(keys: Array<string | undefined>): ProviderStreams {
	const respond = (model: Model, _context: unknown, options?: SimpleStreamOptions) => {
		keys.push(options?.apiKey);
		const stream = new AssistantMessageEventStream();
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1,
		};
		stream.push({ type: "done", reason: "stop", message });
		return stream;
	};
	return { stream: respond, streamSimple: respond };
}

describe("Models (upstream: /packages/ai/test/models-runtime.test.ts)", () => {
	test("resolves request, stored, request environment, then ambient credentials", async () => {
		const keys: Array<string | undefined> = [];
		const credentials = new InMemoryCredentialStore();
		const models = createModels({
			runtime: testTimeRuntime(),
			credentials,
			authContext: { env: async () => "ambient", fileExists: async () => false },
		});
		models.setProvider(
			createProvider({
				id: "opencode-go",
				auth: { apiKey: envApiKeyAuth("OpenCode Go API key", ["OPENCODE_API_KEY"]) },
				models: [testModel],
				api: successfulStreams(keys),
			}),
		);
		await credentials.modify("opencode-go", async () => ({ type: "api_key", key: "stored" }));

		await models.completeSimple(testModel, { messages: [] }, { apiKey: "request" });
		await models.completeSimple(testModel, { messages: [] });
		await credentials.delete("opencode-go");
		await models.completeSimple(testModel, { messages: [] }, { env: { OPENCODE_API_KEY: "request-env" } });
		await models.completeSimple(testModel, { messages: [] });

		expect(keys).toEqual(["request", "stored", "request-env", "ambient"]);
	});

	test("uses an explicit auth snapshot without re-reading changed credentials", async () => {
		const keys: Array<string | undefined> = [];
		const credentials = new InMemoryCredentialStore();
		const models = createModels({
			runtime: testTimeRuntime(),
			credentials,
			authContext: { env: async () => undefined, fileExists: async () => false },
		});
		models.setProvider(
			createProvider({
				id: "opencode-go",
				auth: { apiKey: envApiKeyAuth("OpenCode Go API key", []) },
				models: [testModel],
				api: successfulStreams(keys),
			}),
		);
		await credentials.modify("opencode-go", async () => ({ type: "api_key", key: "run-a" }));
		const authSnapshot = await models.getAuth(testModel);
		await credentials.modify("opencode-go", async () => ({ type: "api_key", key: "run-b" }));

		await models.completeSimple(testModel, { messages: [] }, { authSnapshot });
		await models.completeSimple(testModel, { messages: [] });

		expect(keys).toEqual(["run-a", "run-b"]);
	});

	test("fails closed on an incompatible stored Credential and attaches a safe Diagnostic", async () => {
		const keys: Array<string | undefined> = [];
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("opencode-go", async () => ({
			type: "oauth",
			access: "access",
			refresh: "refresh",
			expires: 10_000,
		}));
		const models = createModels({
			runtime: testTimeRuntime(1_234),
			credentials,
			authContext: { env: async () => "ambient-must-not-win", fileExists: async () => false },
		});
		models.setProvider(
			createProvider({
				id: "opencode-go",
				auth: { apiKey: envApiKeyAuth("OpenCode Go API key", ["OPENCODE_API_KEY"]) },
				models: [testModel],
				api: successfulStreams(keys),
			}),
		);

		const message = await models.completeSimple(testModel, { messages: [] });

		expect(keys).toEqual([]);
		expect(message).toMatchObject({
			stopReason: "error",
			errorMessage: "Provider is not configured: opencode-go",
			timestamp: 1_234,
			diagnostics: [
				{
					timestamp: 1_234,
					error: { code: "auth" },
					details: {
						phase: "auth",
						provider: "opencode-go",
						api: "openai-completions",
						status: null,
						retryable: false,
					},
				},
			],
		});
		expect(message.diagnostics?.[0]?.error).not.toHaveProperty("stack");
	});

	test("merges auth, Model, request, environment, and transformed headers in precedence order", async () => {
		let captured:
			| {
					model: Model;
					options?: SimpleStreamOptions & {
						env?: Record<string, string>;
						headers?: Record<string, string | null>;
					};
			  }
			| undefined;
		const provider = createProvider({
			id: "opencode-go",
			auth: {
				apiKey: {
					name: "Test",
					resolve: async ({ credential }) => ({
						auth: {
							apiKey: credential?.key,
							baseUrl: "https://auth.test/v1",
							headers: { "X-Layer": "auth", "X-Remove": "auth" },
						},
						env: { AUTH_ENV: "auth", SHARED: "auth" },
					}),
				},
			},
			models: [{ ...testModel, headers: { "x-layer": "model" } }],
			api: {
				stream: (requestModel, _context, options) => {
					captured = { model: requestModel, options };
					return successfulStreams([]).streamSimple(requestModel, { messages: [] }, options);
				},
				streamSimple: (requestModel, _context, options) => {
					captured = { model: requestModel, options };
					return successfulStreams([]).streamSimple(requestModel, { messages: [] }, options);
				},
			},
		});
		const modelWithHeaders = provider.getModels()[0]!;
		const models = createModels({ runtime: testTimeRuntime() });
		models.setProvider(provider);

		await models.completeSimple(
			modelWithHeaders,
			{ messages: [] },
			{
				apiKey: "request-key",
				env: { REQUEST_ENV: "request", SHARED: "request" },
				headers: { "X-Layer": "request", "X-Remove": null, "X-Request": "request" },
				transformHeaders: (headers) => ({ ...headers, "X-Transformed": "yes" }),
			},
		);

		expect(captured?.model.baseUrl).toBe("https://auth.test/v1");
		expect(captured?.options).toMatchObject({
			apiKey: "request-key",
			env: { AUTH_ENV: "auth", REQUEST_ENV: "request", SHARED: "request" },
			headers: {
				"X-Layer": "request",
				"X-Remove": null,
				"X-Request": "request",
				"X-Transformed": "yes",
			},
		});
	});

	test("collects refresh errors without rejecting the whole static registry", async () => {
		const models = createModels({ runtime: testTimeRuntime() });
		const provider = createProvider({
			id: "opencode-go",
			auth: { apiKey: envApiKeyAuth("Test", ["TEST_KEY"]) },
			models: [testModel],
			api: successfulStreams([]),
		});
		provider.refreshModels = async () => {
			throw new Error("refresh failed");
		};
		models.setProvider(provider);

		const result = await models.refresh();
		expect(result.aborted).toBe(false);
		expect(result.errors.get("opencode-go")?.message).toBe("refresh failed");
	});
});
