import type { Model } from "@coda/ai";
import type { KeyInput } from "@coda/tui";
import { describe, expect, it, vi } from "vitest";
import { createModelCommandFlow } from "../src/commands/model-flow.ts";
import type { CatalogModel } from "../src/models/model-catalog.ts";
import { type ModelMetadataSource, modelMetadataValue } from "../src/models/model-metadata.ts";
import { CommandFlowHost } from "../src/ui/command-flow-host.ts";

describe("model command flow", () => {
	it("lists a cross-provider pool truthfully and routes unauthenticated models into auth", () => {
		const onSelect = vi.fn();
		const onAuthenticate = vi.fn();
		const host = new CommandFlowHost();
		host.open(
			createModelCommandFlow({
				currentKey: "opencode-go/known",
				models: [
					entry("opencode-go", "known", "configured", metadata("provider")),
					entry("custom", "discovered", "authentication_required", metadata("compatibility")),
				],
				onSelect,
				onAuthenticate,
			}),
		);

		expect(host.view?.items[1]?.description).toContain("context unknown");
		host.handleInput(key("down"));
		host.handleInput(key("enter"));

		expect(onAuthenticate).toHaveBeenCalledWith("custom", expect.anything());
		expect(onSelect).not.toHaveBeenCalled();
	});

	it("requires an explicit Compatibility Mode step for configured models with unknown metadata", () => {
		const onSelect = vi.fn();
		const host = new CommandFlowHost();
		const unknown = entry("custom", "discovered", "configured", metadata("compatibility"));
		host.open(
			createModelCommandFlow({
				currentKey: "opencode-go/known",
				models: [unknown],
				onSelect,
				onAuthenticate: vi.fn(),
			}),
		);

		host.handleInput(key("enter"));
		expect(onSelect).not.toHaveBeenCalled();
		expect(host.view?.breadcrumb).toEqual(["Model", "Compatibility Mode"]);
		expect(host.view?.items[0]).toMatchObject({ label: "Use custom/discovered" });
		expect(host.view?.items[0]?.description).toContain("context cap 16,384");

		host.handleInput(key("enter"));
		expect(onSelect).toHaveBeenCalledWith(unknown.catalog);
		expect(host.view).toBeUndefined();
	});

	it("labels known sources and discloses only field-level Compatibility Mode fallbacks", () => {
		const host = new CommandFlowHost();
		const partial = entry("custom", "partial", "configured", {
			contextWindow: modelMetadataValue(128_000, "provider"),
			maxOutputTokens: modelMetadataValue(4_096, "compatibility"),
			reasoning: modelMetadataValue(true, "user"),
			input: modelMetadataValue(["text", "image"] as const, "provider"),
			price: modelMetadataValue("unreported" as const, "compatibility"),
		});
		host.open(
			createModelCommandFlow({
				currentKey: "opencode-go/known",
				models: [partial],
				onSelect: vi.fn(),
				onAuthenticate: vi.fn(),
			}),
		);

		expect(host.view?.items[0]?.description).toContain("context 128,000 (Provider)");
		expect(host.view?.items[0]?.description).toContain("reasoning yes (configured)");
		host.handleInput(key("enter"));

		expect(host.view?.items[0]?.description).toBe("output cap 4,096 • price unreported");
	});
});

function entry(
	providerId: string,
	id: string,
	auth: "configured" | "authentication_required",
	metadata: CatalogModel["metadata"],
) {
	const model: Model = {
		id,
		name: id,
		api: "openai-completions",
		provider: providerId,
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 16_384,
		maxTokens: 4_096,
	};
	return {
		catalog: {
			key: `${providerId}/${id}`,
			providerId,
			id,
			name: id,
			runtime: model,
			metadata,
		},
		auth,
	} as const;
}

function metadata(source: ModelMetadataSource): CatalogModel["metadata"] {
	return {
		contextWindow: modelMetadataValue(source === "compatibility" ? 16_384 : 128_000, source),
		maxOutputTokens: modelMetadataValue(source === "compatibility" ? 4_096 : 32_000, source),
		reasoning: modelMetadataValue(source === "provider", source),
		input: modelMetadataValue(source === "provider" ? (["text", "image"] as const) : (["text"] as const), source),
		price: modelMetadataValue("unreported" as const, source),
	};
}

function key(keyName: KeyInput["key"], overrides: Partial<KeyInput> = {}): KeyInput {
	return {
		type: "key",
		key: keyName,
		shift: false,
		control: false,
		alt: false,
		meta: false,
		action: "press",
		...overrides,
	};
}
