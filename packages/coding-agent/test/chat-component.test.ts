import type { ComponentInputContext } from "@coda/tui";
import { describe, expect, it, vi } from "vitest";
import { ChatComponent } from "../src/interactive/chat-component.ts";

describe("ChatComponent terminal input", () => {
	it("inserts printable text carried by a normalized KeyInput", () => {
		const component = new ChatComponent({
			modelLabel: "provider/model",
			reasoning: "off",
			onSubmit: vi.fn(),
			onAbort: vi.fn(),
			onExit: vi.fn(),
		});
		const context: ComponentInputContext = {
			requestImmediateRender: vi.fn(),
		};

		component.handleInput(
			{
				type: "key",
				key: "a",
				text: "a",
				shift: false,
				control: false,
				alt: false,
				meta: false,
				action: "press",
			},
			context,
		);

		expect(component.render(80)).toContain("> a");
	});
});
