import { describe, expect, it } from "vitest";
import {
	type Clock,
	Component,
	type CursorPlacement,
	createSystemScheduler,
	FullScreenTui,
	ProcessTerminal,
	type ProcessTerminalInput,
	type ProcessTerminalOutput,
	type RenderContext,
	type ScheduledTask,
	type Scheduler,
	type Terminal,
	type TerminalCapabilities,
	type TerminalImageSurface,
	type TerminalInputListener,
	type TerminalSize,
	VirtualTerminal,
} from "../src/index.ts";
import { StrictScreen } from "./support/strict-screen.ts";

class ManualTime implements Clock, Scheduler {
	#now = 0;
	readonly #tasks: Array<{
		cancelled: boolean;
		dueAt: number;
		run: () => void | Promise<void>;
	}> = [];

	now(): number {
		return this.#now;
	}

	schedule(delayMs: number, run: () => void | Promise<void>): ScheduledTask {
		const task = { cancelled: false, dueAt: this.#now + delayMs, run };
		this.#tasks.push(task);
		return {
			cancel: () => {
				task.cancelled = true;
			},
		};
	}

	async advanceBy(delayMs: number): Promise<void> {
		const target = this.#now + delayMs;
		while (true) {
			const next = this.#tasks
				.filter((task) => !task.cancelled && task.dueAt <= target)
				.sort((left, right) => left.dueAt - right.dueAt)[0];
			if (!next) break;
			next.cancelled = true;
			this.#now = next.dueAt;
			await next.run();
		}
		this.#now = target;
	}
}

class TraceTerminal implements Terminal {
	readonly available: boolean = true;
	started = false;
	readonly size: TerminalSize = Object.freeze({ columns: 80, rows: 24 });
	readonly capabilities: TerminalCapabilities = Object.freeze({
		appearance: "unknown",
		keyboardProtocol: "legacy",
		colorLevel: 1,
		synchronizedOutput: false,
		keyRelease: false,
		sizeFallback: false,
	});
	readonly trace: string[] = [];

	async start(): Promise<boolean> {
		this.trace.push("terminal.start");
		this.started = true;
		return true;
	}

	async stop(): Promise<void> {
		this.trace.push("terminal.stop");
		this.started = false;
	}

	write(data: string): void {
		this.trace.push(`write:${data}`);
	}

	async flush(): Promise<void> {}

	async flushOutput(): Promise<void> {}

	onInput(_listener: TerminalInputListener): () => void {
		this.trace.push("terminal.onInput");
		return () => {};
	}
}

class EnterFlushFailureTerminal extends TraceTerminal {
	#flushes = 0;

	override async flushOutput(): Promise<void> {
		this.#flushes++;
		if (this.#flushes === 1) throw new Error("enter flush failed");
	}
}

class UnavailableTerminal extends TraceTerminal {
	override readonly available: boolean = false;

	override async start(): Promise<boolean> {
		this.trace.push("terminal.start");
		return false;
	}
}

class LateUnavailableTerminal extends TraceTerminal {
	override async start(): Promise<boolean> {
		this.trace.push("terminal.start");
		return false;
	}
}

class ScreenAwareInput implements ProcessTerminalInput {
	isTTY = true;
	isRaw = false;
	readonly #listeners = new Set<(chunk: string | Uint8Array) => void>();

	setRawMode(enabled: boolean): void {
		this.isRaw = enabled;
	}

	setEncoding(): void {}

	resume(): void {}

	pause(): void {}

	on(_event: "data", listener: (chunk: string | Uint8Array) => void): void {
		this.#listeners.add(listener);
	}

	off(_event: "data", listener: (chunk: string | Uint8Array) => void): void {
		this.#listeners.delete(listener);
	}

	read(): null {
		return null;
	}

	emitData(chunk: string): void {
		for (const listener of [...this.#listeners]) listener(chunk);
	}
}

class ScreenAwareOutput implements ProcessTerminalOutput {
	readonly isTTY = true;
	readonly columns = 80;
	readonly rows = 24;
	readonly screen: StrictScreen;
	readonly input: ScreenAwareInput;
	readonly #resizeListeners = new Set<() => void>();

	constructor(screen: StrictScreen, input: ScreenAwareInput) {
		this.screen = screen;
		this.input = input;
	}

	write(data: string, callback?: () => void): boolean {
		for (const response of this.screen.write(data)) queueMicrotask(() => this.input.emitData(response));
		callback?.();
		return true;
	}

	on(_event: "resize", listener: () => void): void {
		this.#resizeListeners.add(listener);
	}

	off(_event: "resize", listener: () => void): void {
		this.#resizeListeners.delete(listener);
	}

	getColorDepth(): number {
		return 24;
	}
}

class ContextProbe extends Component {
	contexts: RenderContext[] = [];

	render(context: RenderContext): string[] {
		this.contexts.push(context);
		return ["ready"];
	}
}

class CursorProbe extends Component {
	render(): string[] {
		return ["top", "editor"];
	}

	cursorPlacement(): CursorPlacement {
		return { row: 1, column: 2, visible: true };
	}
}

class MutableScreen extends Component {
	#lines: string[];

	constructor(lines: string[]) {
		super();
		this.#lines = lines;
	}

	render(): string[] {
		return [...this.#lines];
	}

	set(lines: string[]): void {
		this.#lines = lines;
		this.invalidate();
	}
}

class TraceImageSurface implements TerminalImageSurface {
	readonly capability = null;
	readonly #trace: string[];

	constructor(trace: string[]) {
		this.#trace = trace;
	}

	async reconcile(): Promise<void> {
		this.#trace.push("images.reconcile");
	}

	async dispose(): Promise<void> {
		this.#trace.push("images.dispose");
	}
}

class ThrowingComponent extends Component {
	render(): string[] {
		throw new Error("render failed");
	}
}

class FailingDisposeImageSurface extends TraceImageSurface {
	override async dispose(): Promise<void> {
		await super.dispose();
		throw new Error("image cleanup failed");
	}
}

describe("FullScreenTui", () => {
	it("presents escaped diagnostics in a stable non-blocking footer overlay", async () => {
		const terminal = new VirtualTerminal({ columns: 160, rows: 5 });
		const screen = new StrictScreen(160, 5);
		const time = new ManualTime();
		const tui = new FullScreenTui({
			terminal,
			root: new MutableScreen(["root", "", "", "", "footer"]),
			clock: time,
			scheduler: time,
			keybindings: [],
		});
		await tui.start();
		screen.write(terminal.takeOutput());

		tui.presentDiagnostic({
			code: "terminal.unknown-input",
			message: "Terminal emitted an unknown escape sequence",
			details: { sequence: "\x1b[27;2;13~", c1: "\u009b2J" },
		});
		expect(screen.viewport().at(-1)).toBe("footer");

		await time.advanceBy(150);
		await tui.flush();
		screen.write(terminal.takeOutput());
		expect(screen.viewport().at(-1)).toContain("[terminal.unknown-input]");
		expect(screen.viewport().at(-1)).toContain('sequence="\\u001b[27;2;13~"');
		expect(screen.viewport().at(-1)).toContain('c1="\\u009b2J"');

		await time.advanceBy(3_999);
		await tui.flush();
		screen.write(terminal.takeOutput());
		expect(screen.viewport().at(-1)).toContain("[terminal.unknown-input]");

		await time.advanceBy(1);
		await tui.flush();
		screen.write(terminal.takeOutput());
		expect(screen.viewport().at(-1)).toBe("footer");
		await tui.stop();
	});

	it("renders diagnostics without requiring an explicit flush", async () => {
		const terminal = new VirtualTerminal({ columns: 80, rows: 4 });
		const tui = new FullScreenTui({
			terminal,
			root: new MutableScreen(["root", "", "", "footer"]),
			clock: { now: () => 0 },
			scheduler: createSystemScheduler(),
			keybindings: [],
		});
		await tui.start();
		terminal.clearOutput();

		tui.presentDiagnostic({ code: "terminal.unknown-input", message: "unknown key" });
		await new Promise<void>((resolve) => setTimeout(resolve, 250));

		expect(terminal.readOutput()).toContain("[terminal.unknown-input] unknown key");
		await tui.stop();
	});

	it("deduplicates diagnostic bursts and limits visible updates to once per second", async () => {
		const terminal = new VirtualTerminal({ columns: 80, rows: 4 });
		const screen = new StrictScreen(80, 4);
		const time = new ManualTime();
		const tui = new FullScreenTui({
			terminal,
			root: new MutableScreen(["root", "", "", "footer"]),
			clock: time,
			scheduler: time,
			keybindings: [],
		});
		await tui.start();
		screen.write(terminal.takeOutput());
		const repeated = { code: "terminal.unknown-input", message: "unknown A" };
		tui.presentDiagnostic(repeated);
		tui.presentDiagnostic(repeated);
		tui.presentDiagnostic(repeated);
		await time.advanceBy(150);
		await tui.flush();
		screen.write(terminal.takeOutput());
		expect(screen.viewport().at(-1)).toContain("unknown A ×3");

		tui.presentDiagnostic({ code: "terminal.unknown-input", message: "unknown B" });
		await time.advanceBy(999);
		await tui.flush();
		screen.write(terminal.takeOutput());
		expect(screen.viewport().at(-1)).toContain("unknown A ×3");

		await time.advanceBy(1);
		await tui.flush();
		screen.write(terminal.takeOutput());
		expect(screen.viewport().at(-1)).toContain("unknown B");
		await tui.stop();
	});

	it("does not postpone a diagnostic batch while new diagnostics keep arriving", async () => {
		const terminal = new VirtualTerminal({ columns: 80, rows: 4 });
		const screen = new StrictScreen(80, 4);
		const time = new ManualTime();
		const tui = new FullScreenTui({
			terminal,
			root: new MutableScreen(["root", "", "", "footer"]),
			clock: time,
			scheduler: time,
			keybindings: [],
		});
		await tui.start();
		screen.write(terminal.takeOutput());

		tui.presentDiagnostic({ code: "diagnostic.first", message: "first" });
		await time.advanceBy(100);
		tui.presentDiagnostic({ code: "diagnostic.latest", message: "latest" });
		await time.advanceBy(50);
		await tui.flush();
		screen.write(terminal.takeOutput());

		expect(screen.viewport().at(-1)).toContain("latest");
		await tui.stop();
	});

	it("bounds the in-memory diagnostic queue and reports overflow", async () => {
		const terminal = new VirtualTerminal({ columns: 80, rows: 4 });
		const screen = new StrictScreen(80, 4);
		const time = new ManualTime();
		const tui = new FullScreenTui({
			terminal,
			root: new MutableScreen(["root", "", "", "footer"]),
			clock: time,
			scheduler: time,
			keybindings: [],
		});
		await tui.start();
		screen.write(terminal.takeOutput());
		for (let index = 0; index < 65; index++) {
			tui.presentDiagnostic({ code: `diagnostic.${index}`, message: `message ${index}` });
		}

		await time.advanceBy(150);
		await tui.flush();
		screen.write(terminal.takeOutput());
		expect(screen.viewport().at(-1)).toContain("message 64");
		expect(screen.viewport().at(-1)).toContain("1 older dropped");
		await tui.stop();
	});

	it("negotiates and restores Kitty keyboard flags on the alternate screen", async () => {
		const input = new ScreenAwareInput();
		const screen = new StrictScreen(80, 24);
		const output = new ScreenAwareOutput(screen, input);
		const scheduler = createSystemScheduler();
		const terminal = new ProcessTerminal({ environment: {}, input, output, scheduler });
		const tui = new FullScreenTui({
			terminal,
			root: new ContextProbe(),
			clock: { now: () => 0 },
			scheduler,
			keybindings: [],
		});

		await expect(tui.start()).resolves.toBe(true);
		expect(screen.alternateScreen).toBe(true);
		expect(screen.kittyKeyboardFlags).toEqual({ main: 0, alternate: 7 });

		await tui.stop();
		expect(screen.alternateScreen).toBe(false);
		expect(screen.kittyKeyboardFlags).toEqual({ main: 0, alternate: 0 });
		expect(input.isRaw).toBe(false);
	});

	it("owns alternate-screen ordering and supplies the full render context", async () => {
		const terminal = new TraceTerminal();
		const root = new ContextProbe();
		const tui = new FullScreenTui({
			terminal,
			root,
			clock: { now: () => 123 },
			scheduler: { schedule: () => ({ cancel() {} }) },
			keybindings: [],
		});

		await expect(tui.start()).resolves.toBe(true);
		expect(terminal.trace[0]).toContain("\x1b[?1049h");
		expect(terminal.trace[1]).toBe("terminal.start");
		expect(terminal.trace[2]).toBe("terminal.onInput");
		expect(root.contexts.at(-1)).toEqual({ width: 80, height: 24, now: 123 });

		await tui.stop();
		const stopIndex = terminal.trace.indexOf("terminal.stop");
		expect(stopIndex).toBeGreaterThan(0);
		expect(terminal.trace.slice(0, stopIndex).join("")).toContain("\x1b[?7h");
		expect(terminal.trace.slice(stopIndex + 1).join("")).toContain("\x1b[?1049l");
	});

	it("does not emit full-screen controls when terminal startup is unavailable", async () => {
		const terminal = new UnavailableTerminal();
		const tui = new FullScreenTui({
			terminal,
			root: new ContextProbe(),
			clock: { now: () => 0 },
			scheduler: { schedule: () => ({ cancel() {} }) },
			keybindings: [],
		});

		await expect(tui.start()).resolves.toBe(false);
		expect(terminal.trace).toEqual([]);
		expect(tui.started).toBe(false);
	});

	it("leaves the alternate screen when terminal availability changes during startup", async () => {
		const terminal = new LateUnavailableTerminal();
		const tui = new FullScreenTui({
			terminal,
			root: new ContextProbe(),
			clock: { now: () => 0 },
			scheduler: { schedule: () => ({ cancel() {} }) },
			keybindings: [],
		});

		await expect(tui.start()).resolves.toBe(false);
		expect(terminal.trace[0]).toContain("\x1b[?1049h");
		expect(terminal.trace).toContain("terminal.start");
		expect(terminal.trace).toContain("terminal.stop");
		expect(terminal.trace.at(-1)).toContain("\x1b[?1049l");
		expect(tui.started).toBe(false);
	});

	it("leaves the alternate screen when entering fails after writing terminal state", async () => {
		const terminal = new EnterFlushFailureTerminal();
		const tui = new FullScreenTui({
			terminal,
			root: new ContextProbe(),
			clock: { now: () => 0 },
			scheduler: { schedule: () => ({ cancel() {} }) },
			keybindings: [],
		});

		await expect(tui.start()).rejects.toThrow("enter flush failed");
		expect(terminal.trace.join("")).toContain("\x1b[?1049l");
		expect(terminal.started).toBe(false);
	});

	it("restores terminal state even when image cleanup also fails during startup rollback", async () => {
		const terminal = new TraceTerminal();
		const tui = new FullScreenTui({
			terminal,
			root: new ThrowingComponent(),
			imageSurface: new FailingDisposeImageSurface(terminal.trace),
			clock: { now: () => 0 },
			scheduler: { schedule: () => ({ cancel() {} }) },
			keybindings: [],
		});

		await expect(tui.start()).rejects.toBeInstanceOf(AggregateError);
		expect(terminal.trace).toContain("images.dispose");
		expect(terminal.trace).toContain("terminal.stop");
		expect(terminal.trace.join("")).toContain("\x1b[?1049l");
		expect(terminal.started).toBe(false);
	});

	it("clears stale cells and redraws the complete viewport after resize", async () => {
		const terminal = new VirtualTerminal({ columns: 8, rows: 4 });
		const screen = new StrictScreen(8, 4);
		const root = new MutableScreen(["one", "stale", "tail"]);
		const tui = new FullScreenTui({
			terminal,
			root,
			clock: { now: () => 0 },
			scheduler: { schedule: () => ({ cancel() {} }) },
			keybindings: [],
		});

		await tui.start();
		screen.write(terminal.takeOutput());
		expect(screen.viewport()).toEqual(["one", "stale", "tail", ""]);

		root.set(["new"]);
		await tui.flush();
		screen.write(terminal.takeOutput());
		expect(screen.viewport()).toEqual(["new", "", "", ""]);

		screen.resize(5, 3);
		await terminal.emit({ type: "resize", columns: 5, rows: 3 });
		screen.write(terminal.takeOutput());
		expect(screen.viewport()).toEqual(["new", "", ""]);
		expect(screen.alternateScreen).toBe(true);
		expect(screen.cursorVisible).toBe(false);
		expect(screen.autowrap).toBe(false);
	});

	it("positions and shows the terminal cursor declared by the root component", async () => {
		const terminal = new VirtualTerminal({ columns: 8, rows: 4 });
		const screen = new StrictScreen(8, 4);
		const tui = new FullScreenTui({
			terminal,
			root: new CursorProbe(),
			clock: { now: () => 0 },
			scheduler: { schedule: () => ({ cancel() {} }) },
			keybindings: [],
		});

		await tui.start();
		screen.write(terminal.takeOutput());
		expect(screen.cursorPosition).toEqual({ row: 1, column: 2 });
		expect(screen.cursorVisible).toBe(true);
		await tui.stop();
	});

	it("reconciles images after text and disposes them before terminal shutdown", async () => {
		const terminal = new TraceTerminal();
		const imageSurface = new TraceImageSurface(terminal.trace);
		const tui = new FullScreenTui({
			terminal,
			imageSurface,
			root: new ContextProbe(),
			clock: { now: () => 0 },
			scheduler: { schedule: () => ({ cancel() {} }) },
			keybindings: [],
		});

		await tui.start();
		expect(terminal.trace.indexOf("images.reconcile")).toBeGreaterThan(terminal.trace.indexOf("terminal.start"));
		await tui.stop();
		expect(terminal.trace.indexOf("images.dispose")).toBeLessThan(terminal.trace.indexOf("terminal.stop"));
	});
});
