import { Component, observeInvalidation, type RenderContext, type TerminalInput } from "@coda/tui";
import { describe, expect, it, vi } from "vitest";
import { SwitchableComponent } from "../src/ui/switchable-component.ts";

class Pane extends Component {
	readonly value: string;

	constructor(value: string) {
		super({ focusable: true });
		this.value = value;
	}

	render(_context: RenderContext): string[] {
		return [this.value];
	}

	handleInput = vi.fn((_input: TerminalInput) => undefined);
}

describe("SwitchableComponent", () => {
	it("delegates to the active pane and forwards its invalidations", () => {
		const first = new Pane("first");
		const second = new Pane("second");
		const root = new SwitchableComponent(first);
		const invalidated = vi.fn();
		const detach = observeInvalidation(root, invalidated);
		const context = { width: 80, height: 24, now: 0 };

		expect(root.render(context)).toEqual(["first"]);
		first.invalidate();
		expect(invalidated).toHaveBeenCalledTimes(1);

		root.select(second);
		expect(root.render(context)).toEqual(["second"]);
		first.invalidate();
		second.invalidate();
		expect(invalidated).toHaveBeenCalledTimes(3);

		detach();
	});
});
