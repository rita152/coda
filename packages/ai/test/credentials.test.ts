// Portions derived from Pi:
// /packages/ai/test/models-runtime.test.ts @ 958c13f25080b59d4b736193f972a8502a7a2f8b
// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
// See THIRD_PARTY_NOTICES.md.

import { describe, expect, test } from "vitest";

import { defaultProviderAuthContext, envApiKeyAuth, InMemoryCredentialStore } from "../src/index.ts";

describe("CredentialStore (upstream: /packages/ai/test/models-runtime.test.ts)", () => {
	test("enumerates metadata without exposing secrets", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("api-provider", async () => ({ type: "api_key", key: "secret" }));
		await credentials.modify("oauth-provider", async () => ({
			type: "oauth",
			access: "access-secret",
			refresh: "refresh-secret",
			expires: 10_000,
		}));

		expect(await credentials.list()).toEqual([
			{ providerId: "api-provider", type: "api_key" },
			{ providerId: "oauth-provider", type: "oauth" },
		]);
	});

	test("serializes provider modifications around the latest value", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("provider", async () => ({ type: "api_key", key: "first" }));
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const seen: Array<string | undefined> = [];
		const one = credentials.modify("provider", async (current) => {
			seen.push(current?.type === "api_key" ? current.key : undefined);
			await blocked;
			return { type: "api_key", key: "second" };
		});
		const two = credentials.modify("provider", async (current) => {
			seen.push(current?.type === "api_key" ? current.key : undefined);
			return { type: "api_key", key: "third" };
		});
		release();
		await Promise.all([one, two]);

		expect(seen).toEqual(["first", "second"]);
		expect(await credentials.read("provider")).toEqual({ type: "api_key", key: "third" });
	});

	test("resolves stored keys before injected environment", async () => {
		const auth = envApiKeyAuth("OpenCode Go API key", ["OPENCODE_API_KEY"]);
		const result = await auth.resolve({
			ctx: { env: async () => "environment", fileExists: async () => false },
			credential: { type: "api_key", key: "stored" },
			signal: new AbortController().signal,
		});

		expect(result).toEqual({ auth: { apiKey: "stored" }, env: undefined, source: "stored credential" });
	});

	test("keeps default filesystem probing inert so persistence stays caller-owned", async () => {
		const context = defaultProviderAuthContext();
		await expect(context.fileExists(new URL("../package.json", import.meta.url).pathname)).resolves.toBe(false);
	});
});
