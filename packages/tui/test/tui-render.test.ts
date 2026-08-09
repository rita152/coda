import { describe, expect, it, vi } from "vitest";
import {
	type Clock,
	Component,
	type DiagnosticSink,
	type RenderContext,
	RendererError,
	type ScheduledTask,
	type Scheduler,
	Tui,
	VirtualTerminal,
} from "../src/index.ts";

class ManualClock implements Clock {
	value = 0;

	now(): number {
		return this.value;
	}
}

class ManualScheduler implements Scheduler {
	readonly tasks: Array<{ cancelled: boolean; delayMs: number; run: () => void | Promise<void> }> = [];

	schedule(delayMs: number, run: () => void | Promise<void>): ScheduledTask {
		const task = { cancelled: false, delayMs, run };
		this.tasks.push(task);
		return {
			cancel: () => {
				task.cancelled = true;
			},
		};
	}

	get pending(): number {
		return this.tasks.filter((task) => !task.cancelled).length;
	}

	async runNext(clock?: ManualClock): Promise<void> {
		const task = this.tasks.find((candidate) => !candidate.cancelled);
		if (!task) throw new Error("No scheduled task");
		task.cancelled = true;
		if (clock) clock.value += task.delayMs;
		await task.run();
	}
}

class Lines extends Component {
	lines: string[];
	readonly widths: number[] = [];

	constructor(lines: string[]) {
		super();
		this.lines = lines;
	}

	render(context: RenderContext): string[] {
		this.widths.push(context.width);
		return [...this.lines];
	}

	set(lines: string[]): void {
		this.lines = lines;
		this.invalidate();
	}
}

class ReentrantProbe extends Component {
	activeRenders = 0;
	maxActiveRenders = 0;
	requestDuringNextRender?: () => void;

	render(): string[] {
		this.activeRenders++;
		this.maxActiveRenders = Math.max(this.maxActiveRenders, this.activeRenders);
		const request = this.requestDuringNextRender;
		this.requestDuringNextRender = undefined;
		request?.();
		this.activeRenders--;
		return ["probe"];
	}
}

class AnimatedProbe extends Component {
	render(context: RenderContext): string[] {
		return [`frame ${context.now}`];
	}

	override animationInterval(): number {
		return 100;
	}
}

class DeferredVirtualTerminal extends VirtualTerminal {
	#releaseStart?: () => void;
	readonly #startGate = new Promise<void>((resolve) => {
		this.#releaseStart = resolve;
	});

	releaseStart(): void {
		this.#releaseStart?.();
	}

	override async start(): Promise<boolean> {
		await this.#startGate;
		return super.start();
	}
}

class RejectingTerminal extends VirtualTerminal {
	activeInputSubscriptions = 0;
	stopCalls = 0;

	override onInput(listener: Parameters<VirtualTerminal["onInput"]>[0]): () => void {
		this.activeInputSubscriptions++;
		const unsubscribe = super.onInput(listener);
		return () => {
			this.activeInputSubscriptions--;
			unsubscribe();
		};
	}

	override async start(): Promise<boolean> {
		throw new Error("start failed");
	}

	override async stop(): Promise<void> {
		this.stopCalls++;
		await super.stop();
	}
}

function setup(lines: string[], terminal = new VirtualTerminal({ columns: 20, rows: 5 })) {
	const clock = new ManualClock();
	const scheduler = new ManualScheduler();
	const root = new Lines(lines);
	const diagnostics = vi.fn<DiagnosticSink>();
	const tui = new Tui({ clock, diagnostics, keybindings: [], root, scheduler, terminal });
	return { clock, diagnostics, root, scheduler, terminal, tui };
}

describe("Tui full-screen differential rendering", () => {
	it("starts idempotently and only rewrites changed rows", async () => {
		const { root, terminal, tui } = setup(["one", "two"]);

		await expect(tui.start()).resolves.toBe(true);
		await expect(tui.start()).resolves.toBe(true);
		expect(tui.started).toBe(true);
		expect(terminal.readOutput()).toContain("\x1b[1;1H\x1b[2Kone");
		expect(terminal.readOutput()).toContain("\x1b[2;1H\x1b[2Ktwo");
		terminal.clearOutput();

		root.set(["one", "TWO"]);
		await tui.flush();

		expect(terminal.readOutput()).not.toContain("\x1b[1;1H");
		expect(terminal.readOutput()).toContain("\x1b[2;1H\x1b[2KTWO");
		await expect(tui.stop()).resolves.toBeUndefined();
		await expect(tui.stop()).resolves.toBeUndefined();
		expect(tui.started).toBe(false);
		expect(terminal.started).toBe(false);
	});

	it("coalesces invalidations behind the injected 60fps scheduler", async () => {
		const { clock, root, scheduler, terminal, tui } = setup(["first"]);
		await tui.start();
		terminal.clearOutput();

		root.set(["second"]);
		root.invalidate();
		root.invalidate();

		expect(scheduler.pending).toBe(1);
		expect(scheduler.tasks[0]?.delayMs).toBeCloseTo(1000 / 60);
		expect(terminal.readOutput()).toBe("");
		await scheduler.runNext(clock);
		await tui.flush();
		expect(terminal.readOutput()).toContain("second");
	});

	it("owns one cancellable animation loop for animated components", async () => {
		const terminal = new VirtualTerminal({ columns: 20, rows: 5 });
		const clock = new ManualClock();
		const scheduler = new ManualScheduler();
		const tui = new Tui({ clock, keybindings: [], root: new AnimatedProbe(), scheduler, terminal });

		await tui.start();
		expect(scheduler.pending).toBe(1);
		terminal.clearOutput();
		await scheduler.runNext(clock);
		expect(terminal.readOutput()).toContain("frame 100");
		expect(scheduler.pending).toBe(1);

		await tui.stop();
		expect(scheduler.pending).toBe(0);
	});

	it("flushes a scheduled frame deterministically without waiting for its timer", async () => {
		const { root, scheduler, terminal, tui } = setup(["before"]);
		await tui.start();
		terminal.clearOutput();
		root.set(["after"]);

		await tui.flush();

		expect(scheduler.pending).toBe(0);
		expect(terminal.readOutput()).toContain("after");
	});

	it("renders resize input immediately using the updated immutable size", async () => {
		const { root, scheduler, terminal, tui } = setup(["line"]);
		await tui.start();
		terminal.clearOutput();

		await terminal.emit({ type: "resize", columns: 12, rows: 3 });

		expect(root.widths.at(-1)).toBe(12);
		expect(scheduler.pending).toBe(0);
	});

	it("uses synchronized output only when the Terminal instance supports it", async () => {
		const supported = setup(["line"]);
		await supported.tui.start();
		expect(supported.terminal.readOutput()).toContain("\x1b[?2026h");
		expect(supported.terminal.readOutput()).toContain("\x1b[?2026l");

		const plainTerminal = new VirtualTerminal({ capabilities: { synchronizedOutput: false } });
		const plain = setup(["line"], plainTerminal);
		await plain.tui.start();
		expect(plainTerminal.readOutput()).not.toContain("?2026");
	});

	it("fails explicitly on over-width output and reports through the injected sink", async () => {
		const terminal = new VirtualTerminal({ columns: 5, rows: 2 });
		const { diagnostics, tui } = setup(["too-wide"], terminal);

		await expect(tui.start()).rejects.toBeInstanceOf(RendererError);
		expect(terminal.started).toBe(false);
		expect(diagnostics).toHaveBeenCalledWith(
			expect.objectContaining({
				code: "renderer.over-width",
				details: { actualWidth: 8, availableWidth: 5, row: 0 },
			}),
		);
	});

	it("never re-enters component rendering when renderNow is requested mid-frame", async () => {
		const terminal = new VirtualTerminal();
		const scheduler = new ManualScheduler();
		const root = new ReentrantProbe();
		const tui = new Tui({ clock: new ManualClock(), keybindings: [], root, scheduler, terminal });
		await tui.start();

		root.requestDuringNextRender = () => {
			void tui.renderNow();
		};
		root.invalidate();
		await tui.flush();

		expect(root.maxActiveRenders).toBe(1);
	});

	it("settles an in-flight start before performing an idempotent stop", async () => {
		const terminal = new DeferredVirtualTerminal();
		const tui = new Tui({
			clock: new ManualClock(),
			keybindings: [],
			root: new Lines(["line"]),
			scheduler: new ManualScheduler(),
			terminal,
		});

		const starting = tui.start();
		const stopping = tui.stop();
		terminal.releaseStart();
		await starting;
		await stopping;

		expect(tui.started).toBe(false);
		expect(terminal.started).toBe(false);
	});

	it("removes its input subscription when Terminal start fails", async () => {
		const terminal = new RejectingTerminal();
		const tui = new Tui({
			clock: new ManualClock(),
			keybindings: [],
			root: new Lines(["line"]),
			scheduler: new ManualScheduler(),
			terminal,
		});

		await expect(tui.start()).rejects.toThrow("start failed");

		expect(terminal.activeInputSubscriptions).toBe(0);
		expect(tui.started).toBe(false);
	});

	it("rejects embedded newlines as an explicit renderer invariant", async () => {
		const { diagnostics, tui } = setup(["one\ntwo"]);

		await expect(tui.start()).rejects.toMatchObject({ code: "renderer.invalid-line" });
		expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({ code: "renderer.invalid-line" }));
	});
});
