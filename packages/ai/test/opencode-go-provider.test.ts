// Portions derived from Pi:
// /packages/ai/test/providers.test.ts @ 958c13f25080b59d4b736193f972a8502a7a2f8b
// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
// See THIRD_PARTY_NOTICES.md.

import { describe, expect, test } from "vitest";

import { createModels } from "../src/index.ts";
import { opencodeGoProvider } from "../src/providers/opencode-go.ts";
import { testTimeRuntime } from "./time-runtime.ts";

describe("OpenCode Go provider (upstream: /packages/ai/test/providers.test.ts)", () => {
	test("exposes the complete static mixed-Api catalog and refreshes without network access", async () => {
		const provider = opencodeGoProvider();
		const models = createModels({
			runtime: testTimeRuntime(),
			authContext: { env: async () => undefined, fileExists: async () => false },
		});
		models.setProvider(provider);

		expect(provider.id).toBe("opencode-go");
		expect(provider.name).toBe("OpenCode Go");
		expect(provider.getModels()).toHaveLength(18);
		expect(new Set(provider.getModels().map((model) => model.api))).toEqual(
			new Set(["anthropic-messages", "openai-completions", "openai-responses"]),
		);
		await expect(models.refresh()).resolves.toMatchObject({ aborted: false });
	});

	test("declares API-key auth only and rejects OAuth login as unsupported", async () => {
		const provider = opencodeGoProvider();
		const models = createModels({ runtime: testTimeRuntime() });
		models.setProvider(provider);

		expect(provider.auth.apiKey?.name).toBe("OpenCode API key");
		expect(provider.auth.oauth).toBeUndefined();
		await expect(
			models.login("opencode-go", "oauth", {
				prompt: async () => "unused",
				notify: () => {},
			}),
		).rejects.toMatchObject({ code: "auth" });
	});

	test("reports unsupported deferred operations as provider errors", async () => {
		const provider = opencodeGoProvider();
		const models = createModels({ runtime: testTimeRuntime() });
		models.setProvider(provider);
		const selected = provider.getModels()[0]!;

		await expect(
			models.fetchDeferred(selected, {
				provider: provider.id,
				modelId: selected.id,
				api: selected.api,
				id: "deferred_1",
			}),
		).rejects.toMatchObject({ code: "provider" });
	});
});
