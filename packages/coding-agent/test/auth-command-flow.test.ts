import type { KeyInput } from "@coda/tui";
import { describe, expect, it, vi } from "vitest";
import { createAuthCommandFlow } from "../src/commands/auth-flow.ts";
import { CommandFlowHost } from "../src/interactive/command-flow-host.ts";

describe("auth command flow", () => {
	it("keeps OAuth visible but disabled and exposes configured providers under API key login", () => {
		const host = new CommandFlowHost();
		host.open(
			createAuthCommandFlow({
				providers: [{ id: "opencode-go", name: "OpenCode Go", configured: true }],
				onUpdateApiKey: vi.fn(),
				onLogout: vi.fn(),
				onAddCustomProvider: vi.fn(),
			}),
		);

		expect(host.view?.items[0]).toMatchObject({ label: "Log in with OAuth", disabledReason: "Coming soon" });
		host.handleInput(key("down"));
		host.handleInput(key("enter"));

		expect(host.view?.breadcrumb).toEqual(["Authentication", "API key"]);
		expect(host.view?.items).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "provider:opencode-go", status: "configured" }),
				expect.objectContaining({ id: "custom-provider", label: "Custom provider" }),
			]),
		);
	});

	it("collects custom provider fields in order with protocol constrained to the predefined menu", () => {
		const onAddCustomProvider = vi.fn();
		const host = new CommandFlowHost();
		host.open(
			createAuthCommandFlow({
				providers: [{ id: "opencode-go", name: "OpenCode Go", configured: true }],
				onUpdateApiKey: vi.fn(),
				onLogout: vi.fn(),
				onAddCustomProvider,
			}),
		);
		host.handleInput(key("down"));
		host.handleInput(key("enter"));
		host.handleInput(key("down"));
		host.handleInput(key("enter"));

		host.handleInput({ type: "text", text: "Acme AI" });
		host.handleInput(key("enter"));
		expect(host.view?.items.map(({ id }) => id)).toEqual([
			"openai.chatcompletions",
			"openai.responses",
			"anthropic.messages",
		]);
		host.handleInput(key("down"));
		host.handleInput(key("enter"));
		host.handleInput({ type: "text", text: "https://api.acme.test/v1" });
		host.handleInput(key("enter"));
		host.handleInput({ type: "text", text: "secret" });
		host.handleInput(key("enter"));

		expect(onAddCustomProvider).toHaveBeenCalledWith({
			providerName: "Acme AI",
			apiProtocol: "openai.responses",
			baseUrl: "https://api.acme.test/v1",
			apiKey: "secret",
		});
		expect(host.view).toBeUndefined();
	});
});

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
