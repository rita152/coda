import { describe, expect, it } from "vitest";
import {
	type Clock,
	Component,
	type ComponentInputContext,
	FocusError,
	type Keybinding,
	type RenderContext,
	type ScheduledTask,
	type Scheduler,
	stripAnsi,
	type TerminalInput,
	Tui,
	VirtualTerminal,
} from "../src/index.ts";

const clock: Clock = { now: () => 0 };

class QueuedScheduler implements Scheduler {
	readonly tasks: Array<{ cancelled: boolean; run: () => void | Promise<void> }> = [];

	schedule(_delayMs: number, run: () => void | Promise<void>): ScheduledTask {
		const task = { cancelled: false, run };
		this.tasks.push(task);
		return {
			cancel: () => {
				task.cancelled = true;
			},
		};
	}
}

class InteractiveComponent extends Component {
	lines: string[];
	readonly inputs: TerminalInput[] = [];
	immediateOnInput = false;

	constructor(lines: string[], focusable = true) {
		super({ focusable });
		this.lines = lines;
	}

	render(): string[] {
		return [...this.lines];
	}

	async handleInput(input: TerminalInput, context: ComponentInputContext): Promise<void> {
		this.inputs.push(input);
		if (this.immediateOnInput) {
			this.lines = [input.type === "text" ? input.text : input.type];
			context.requestImmediateRender();
		}
	}
}

class ContextOverlay extends Component {
	readonly contexts: RenderContext[] = [];

	render(context: RenderContext): string[] {
		this.contexts.push(context);
		return [`${context.width}x${context.height}`];
	}
}

function key(keyName: "k" | "x", control = false) {
	return {
		type: "key" as const,
		key: keyName,
		shift: false,
		control,
		alt: false,
		meta: false,
		action: "press" as const,
	};
}

function createTui(root: Component, keybindings: readonly Keybinding[] = []) {
	const terminal = new VirtualTerminal({ columns: 12, rows: 5 });
	const scheduler = new QueuedScheduler();
	const tui = new Tui({ clock, keybindings, root, scheduler, terminal });
	return { scheduler, terminal, tui };
}

describe("Tui input routing and focus", () => {
	it("runs explicitly injected keybindings before the focused component", async () => {
		const root = new InteractiveComponent(["root"]);
		const calls: string[] = [];
		const keybindings: Keybinding[] = [
			{
				pattern: { key: "k", control: true },
				handle: async () => {
					calls.push("binding");
					await Promise.resolve();
					return true;
				},
			},
		];
		const { terminal, tui } = createTui(root, keybindings);
		await tui.start();

		await terminal.emit(key("k", true));
		await terminal.emit({ type: "text", text: "hello" });

		expect(calls).toEqual(["binding"]);
		expect(root.inputs).toEqual([{ type: "text", text: "hello" }]);
	});

	it("renders immediately after the input callback when requested", async () => {
		const root = new InteractiveComponent(["before"]);
		root.immediateOnInput = true;
		const { scheduler, terminal, tui } = createTui(root);
		await tui.start();
		terminal.clearOutput();

		await terminal.emit({ type: "text", text: "after" });

		expect(scheduler.tasks.filter((task) => !task.cancelled)).toHaveLength(0);
		expect(terminal.readOutput()).toContain("after");
	});

	it("only focuses mounted, focusable, visible components", async () => {
		const root = new InteractiveComponent(["root"]);
		const unmounted = new InteractiveComponent(["outside"]);
		const notFocusable = new InteractiveComponent(["plain"], false);
		const { tui } = createTui(root);
		await tui.start();

		expect(tui.focused).toBe(root);
		expect(() => tui.focus(unmounted)).toThrow(FocusError);
		const handle = tui.showOverlay(notFocusable, { row: 1, column: 0, width: 5 });
		expect(() => tui.focus(notFocusable)).toThrow(FocusError);
		handle.hide();
		expect(() => handle.focus()).toThrow(FocusError);
	});
});

describe("stable overlay handles", () => {
	it("recomputes dynamic placement from the current terminal size", async () => {
		const root = new InteractiveComponent(["root"]);
		const overlay = new ContextOverlay();
		const { terminal, tui } = createTui(root);
		tui.showOverlay(overlay, {
			layout: ({ columns, rows }) => ({ row: rows - 2, column: 1, width: columns - 2, height: 2 }),
		});
		await tui.start();

		expect(overlay.contexts.at(-1)).toMatchObject({ width: 10, height: 2 });
		await terminal.emit({ type: "resize", columns: 8, rows: 4 });
		expect(overlay.contexts.at(-1)).toMatchObject({ width: 6, height: 2 });
		expect(stripAnsi(terminal.readOutput())).toContain("6x2");
	});

	it("composites overlays and lets each handle hide and show only its own target", async () => {
		const root = new InteractiveComponent(["abcdefghij", "0123456789"]);
		const first = new InteractiveComponent(["XX"]);
		const second = new InteractiveComponent(["YY"]);
		const { terminal, tui } = createTui(root);
		await tui.start();
		terminal.clearOutput();

		const firstHandle = tui.showOverlay(first, { row: 0, column: 2, width: 2 });
		const secondHandle = tui.showOverlay(second, { row: 1, column: 4, width: 2 });
		await tui.flush();
		expect(stripAnsi(terminal.takeOutput())).toContain("abXXefghij");
		expect(firstHandle.visible).toBe(true);
		expect(secondHandle.visible).toBe(true);

		firstHandle.hide();
		await tui.flush();
		const output = stripAnsi(terminal.takeOutput());
		expect(output).toContain("abcdefghij");
		expect(output).not.toContain("0123YY6789");
		expect(firstHandle.visible).toBe(false);
		expect(secondHandle.visible).toBe(true);

		firstHandle.show();
		await tui.flush();
		expect(stripAnsi(terminal.takeOutput())).toContain("abXXefghij");
	});

	it("restores the exact prior focus and makes removal permanent", async () => {
		const root = new InteractiveComponent(["root"]);
		const overlay = new InteractiveComponent(["modal"]);
		const { tui } = createTui(root);
		await tui.start();

		const handle = tui.showOverlay(overlay, { focus: true, row: 1, column: 1, width: 5 });
		expect(tui.focused).toBe(overlay);
		handle.hide();
		expect(tui.focused).toBe(root);
		handle.show();
		handle.focus();
		expect(tui.focused).toBe(overlay);

		handle.remove();
		expect(handle.removed).toBe(true);
		expect(tui.focused).toBe(root);
		expect(() => handle.show()).toThrowError(/removed/);
	});

	it("restores focus to a visible overlay across a terminal stop and restart", async () => {
		const root = new InteractiveComponent(["root"]);
		const overlay = new InteractiveComponent(["dialog"]);
		const { tui } = createTui(root);
		await tui.start();
		tui.showOverlay(overlay, { focus: true, row: 1, column: 1, width: 8 });

		await tui.stop();
		await tui.start();

		expect(tui.focused).toBe(overlay);
	});
});
