import { describe, expect, it } from "vitest";
import {
	Component,
	type CursorPlacement,
	FullScreenTui,
	type RenderContext,
	type Terminal,
	type TerminalCapabilities,
	type TerminalImageSurface,
	type TerminalInputListener,
	type TerminalSize,
	VirtualTerminal,
} from "../src/index.ts";
import { StrictScreen } from "./support/strict-screen.ts";

class TraceTerminal implements Terminal {
	started = false;
	readonly size: TerminalSize = Object.freeze({ columns: 80, rows: 24 });
	readonly capabilities: TerminalCapabilities = Object.freeze({
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
	override async start(): Promise<boolean> {
		this.trace.push("terminal.start");
		return false;
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
		expect(terminal.trace[0]).toBe("terminal.start");
		expect(terminal.trace[1]).toContain("\x1b[?1049h");
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
		expect(terminal.trace).toEqual(["terminal.start"]);
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
