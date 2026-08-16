import { displayWidth, type KeyInput, stripAnsi } from "@coda/tui";
import { describe, expect, it, vi } from "vitest";
import {
	CommandFlowHost,
	type CommandFlowMenu,
	type CommandFlowNavigation,
	renderCommandFlow,
} from "../src/ui/command-flow-host.ts";
import { createCodaTheme } from "../src/ui/theme.ts";

describe("CommandFlowHost", () => {
	it("navigates nested menus with Enter and unwinds them one level at a time with Escape", () => {
		const host = new CommandFlowHost();
		const confirmation: CommandFlowMenu = {
			id: "settings:confirm",
			title: "Confirm Reset",
			items: [{ id: "confirm", label: "Confirm" }],
		};
		const root: CommandFlowMenu = {
			id: "settings",
			title: "Settings",
			items: [
				{
					id: "reset",
					label: "Reset",
					onSelect: (navigation: CommandFlowNavigation) => navigation.push(confirmation),
				},
			],
		};
		host.open(root);

		expect(host.handleInput(key("enter"))).toEqual({ type: "handled" });
		expect(host.view?.breadcrumb).toEqual(["Settings", "Confirm Reset"]);

		expect(host.handleInput(key("escape"))).toEqual({ type: "handled" });
		expect(host.view?.breadcrumb).toEqual(["Settings"]);

		expect(host.handleInput(key("escape"))).toEqual({ type: "handled" });
		expect(host.view).toBeUndefined();
	});

	it("moves the menu selection with arrow keys", () => {
		const host = new CommandFlowHost();
		host.open({
			id: "model",
			title: "Model",
			items: [
				{ id: "first", label: "First" },
				{ id: "second", label: "Second" },
			],
		});

		expect(host.handleInput(key("down"))).toEqual({ type: "handled" });
		expect(host.view?.items.map(({ id, selected }) => ({ id, selected }))).toEqual([
			{ id: "first", selected: false },
			{ id: "second", selected: true },
		]);
	});

	it("renders breadcrumbs and item status in the shared borderless upper list", () => {
		const host = new CommandFlowHost();
		host.open({
			id: "auth",
			title: "Authentication",
			items: [
				{ id: "oauth", label: "Log in with OAuth", disabledReason: "Coming soon" },
				{ id: "api-key", label: "Log in with API key", status: "configured" },
			],
		});

		const rendered = renderCommandFlow(host.view!, 56, 6, createCodaTheme(0)).map(stripAnsi);
		const output = rendered.join("\n");

		expect(rendered[0]).toBe("  Authentication");
		expect(output).toContain("→ Log in with OAuth");
		expect(output).toContain("Coming soon");
		expect(output).toContain("configured");
		expect(output).not.toMatch(/[╭╮╰╯│]/u);
		expect(output).not.toContain("Enter select • Esc back");
	});

	it("notifies its owner when asynchronous navigation changes the drawer", async () => {
		let finish!: () => void;
		const pending = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const onChange = vi.fn();
		const host = new CommandFlowHost({ onChange });
		host.open({
			id: "async",
			title: "Async",
			items: [
				{
					id: "finish",
					label: "Finish",
					onSelect: async (navigation) => {
						await pending;
						navigation.close();
					},
				},
			],
		});
		onChange.mockClear();

		host.handleInput(key("enter"));
		finish();

		await vi.waitFor(() => expect(host.view).toBeUndefined());
		expect(onChange).toHaveBeenCalled();
	});

	it("routes rejected menu actions to its owner without an unhandled rejection", async () => {
		const onError = vi.fn();
		const host = new CommandFlowHost({ onError });
		host.open({
			id: "failing",
			title: "Failing",
			items: [
				{
					id: "submit",
					label: "Submit",
					onSelect: async () => {
						throw new Error("Provider discovery failed");
					},
				},
			],
		});

		host.handleInput(key("enter"));

		await vi.waitFor(() =>
			expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "Provider discovery failed" })),
		);
		expect(host.view?.menuId).toBe("failing");
	});

	it("filters large menu pages case-insensitively while keeping selection keyboard-owned", () => {
		const host = new CommandFlowHost();
		host.open({
			id: "models",
			title: "Models",
			filterable: true,
			items: [
				{ id: "alpha", label: "Provider/Alpha" },
				{ id: "beta", label: "Provider/Beta" },
			],
		});

		host.handleInput({ type: "text", text: "BE" });

		expect(host.view?.query).toBe("BE");
		expect(host.view?.items.map(({ id, selected }) => ({ id, selected }))).toEqual([{ id: "beta", selected: true }]);
	});

	it("renders Session menus as full-width Codex-style title and metadata rows", () => {
		const host = new CommandFlowHost();
		host.open({
			id: "session",
			title: "Switch session",
			filterable: true,
			presentation: "sessions",
			emptyMessage: "No sessions yet",
			items: [
				{
					id: "session-12345678",
					label: "Implement a readable session picker",
					description: "15m ago · openai/gpt-5 · OpenAI Responses · 2 prompts",
					status: "current",
				},
			],
		});

		const rendered = renderCommandFlow(host.view!, 96, 6, createCodaTheme(0)).map(stripAnsi);

		expect(rendered).toEqual([
			"  Switch session · type to search",
			"❯ Implement a readable session picker",
			"  current · 15m ago · openai/gpt-5 · OpenAI Responses · 2 prompts",
		]);
	});

	it("keeps Session titles readable on narrow terminals and renders a useful empty state", () => {
		const host = new CommandFlowHost();
		host.open({
			id: "session",
			title: "Switch session",
			filterable: true,
			presentation: "sessions",
			emptyMessage: "No sessions yet",
			items: [
				{
					id: "session-1",
					label: "Readable title",
					description: "15m ago · anthropic/claude · Anthropic Messages · 1 prompt",
					status: "idle",
				},
			],
		});

		const rendered = renderCommandFlow(host.view!, 40, 4, createCodaTheme(0)).map(stripAnsi);
		expect(rendered[1]).toBe("❯ Readable title");
		expect(rendered.every((line) => displayWidth(line) <= 40)).toBe(true);

		host.open({
			id: "session",
			title: "Switch session",
			filterable: true,
			presentation: "sessions",
			emptyMessage: "No sessions yet",
			items: [],
		});
		expect(renderCommandFlow(host.view!, 40, 4, createCodaTheme(0)).map(stripAnsi)).toContain("  No sessions yet");
	});

	it("captures a secret prompt without exposing its value in the render view", () => {
		const onSubmit = vi.fn();
		const host = new CommandFlowHost();
		host.open({
			id: "api-key",
			title: "API key",
			label: "API key",
			secret: true,
			onSubmit,
		});

		host.handleInput({ type: "text", text: "sk-test" });

		expect(host.view?.prompt?.displayValue).toBe("•••••••");
		expect(JSON.stringify(host.view)).not.toContain("sk-test");
		host.handleInput(key("enter"));
		expect(onSubmit).toHaveBeenCalledWith("sk-test", expect.anything());
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
