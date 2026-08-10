import type { Model } from "@coda/ai";
import type { KeyInput } from "@coda/tui";
import { describe, expect, it, vi } from "vitest";
import { createModelCommandFlow } from "../src/commands/model-flow.ts";
import { CommandFlowHost } from "../src/interactive/command-flow-host.ts";
import type { CatalogModel } from "../src/runtime/model-catalog.ts";

describe("model command flow", () => {
	it("lists a cross-provider pool truthfully and routes unauthenticated models into auth", () => {
		const onSelect = vi.fn();
		const onAuthenticate = vi.fn();
		const host = new CommandFlowHost();
		host.open(
			createModelCommandFlow({
				currentKey: "opencode-go/known",
				models: [
					entry("opencode-go", "known", "configured", {
						contextWindow: 128_000,
						maxOutputTokens: 32_000,
						reasoning: true,
						imageInput: true,
						price: "unknown",
					}),
					entry("custom", "discovered", "authentication_required", {
						contextWindow: "unknown",
						maxOutputTokens: "unknown",
						reasoning: "unknown",
						imageInput: "unknown",
						price: "unknown",
					}),
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
		const unknown = entry("custom", "discovered", "configured", {
			contextWindow: "unknown",
			maxOutputTokens: "unknown",
			reasoning: "unknown",
			imageInput: "unknown",
			price: "unknown",
		});
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
			...(Object.values(metadata).includes("unknown")
				? {
						compatibility: {
							contextWindow: 16_384,
							maxOutputTokens: 4_096,
							reasoning: false as const,
							imageInput: false as const,
							price: "unreported" as const,
						},
					}
				: {}),
		},
		auth,
	} as const;
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
