import { Component, createSystemScheduler, stripAnsi, Tui, VirtualTerminal } from "@coda/tui";
import { describe, expect, it } from "vitest";
import { InteractivePermissionSelector } from "../src/interactive/permission-selector.ts";

class RootComponent extends Component {
	constructor() {
		super({ focusable: true });
	}

	render(): string[] {
		return ["chat"];
	}
}

function key(value: "1" | "2" | "3" | "escape"): Extract<Parameters<VirtualTerminal["emit"]>[0], { type: "key" }> {
	return {
		type: "key",
		key: value,
		text: value.length === 1 ? value : undefined,
		shift: false,
		control: false,
		alt: false,
		meta: false,
		action: "press",
	};
}

async function fixture(): Promise<{
	readonly terminal: VirtualTerminal;
	readonly tui: Tui;
	readonly selector: InteractivePermissionSelector;
}> {
	const terminal = new VirtualTerminal({ columns: 88, rows: 24 });
	const tui = new Tui({
		terminal,
		root: new RootComponent(),
		clock: { now: () => 1_000 },
		scheduler: createSystemScheduler(),
		keybindings: [],
	});
	await tui.start();
	return { terminal, tui, selector: new InteractivePermissionSelector(tui) };
}

describe("interactive Permission profile selector", () => {
	it("switches directly between confined profiles and restores chat focus", async () => {
		const { terminal, tui, selector } = await fixture();
		const root = tui.focused;
		const pending = selector.select("read-only");
		await tui.renderNow();
		expect(stripAnsi(terminal.readOutput())).toContain("Active: Read Only");

		await terminal.emit(key("2"));
		await expect(pending).resolves.toBe("workspace");
		expect(tui.focused).toBe(root);
		await tui.stop();
	});

	it("requires profile selection and one explicit warning confirmation before enabling Full Access", async () => {
		const { terminal, tui, selector } = await fixture();
		const pending = selector.select("workspace");

		await terminal.emit(key("3"));
		await tui.renderNow();
		expect(stripAnsi(terminal.readOutput())).toContain("Enable Full Access for this session?");
		await terminal.emit(key("1"));

		await expect(pending).resolves.toBe("full-access");
		await tui.stop();
	});

	it("returns to the profile menu when the Full Access warning is explicitly cancelled", async () => {
		const { terminal, tui, selector } = await fixture();
		const pending = selector.select("workspace");

		await terminal.emit(key("3"));
		await terminal.emit(key("2"));
		await tui.renderNow();
		expect(stripAnsi(terminal.readOutput())).toContain("Select Permission Profile");
		await terminal.emit(key("1"));

		await expect(pending).resolves.toBe("read-only");
		await tui.stop();
	});

	it("cancels Full Access at either confirmation without changing the profile", async () => {
		const { terminal, tui, selector } = await fixture();
		const pending = selector.select("workspace");
		await terminal.emit(key("3"));
		await terminal.emit(key("escape"));

		await expect(pending).resolves.toBeUndefined();
		await tui.stop();
	});
});
