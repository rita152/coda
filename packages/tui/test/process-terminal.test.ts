import { describe, expect, it, vi } from "vitest";
import {
	type DiagnosticSink,
	Editor,
	ProcessTerminal,
	type ProcessTerminalInput,
	type ProcessTerminalOutput,
	type ScheduledTask,
	type Scheduler,
	type TerminalInput,
} from "../src/index.ts";

class ManualScheduler implements Scheduler {
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

	async runNext(): Promise<void> {
		const task = this.tasks.find((candidate) => !candidate.cancelled);
		if (!task) throw new Error("No pending task");
		task.cancelled = true;
		await task.run();
	}
}

class FakeInput implements ProcessTerminalInput {
	isTTY = true;
	isRaw = false;
	encoding?: BufferEncoding;
	resumed = false;
	paused = false;
	readonly rawModes: boolean[] = [];
	readonly queuedReads: Array<string | Buffer> = [];
	readCalls = 0;
	readError?: Error;
	readonly #dataListeners = new Set<(chunk: string | Uint8Array) => void>();

	setRawMode(enabled: boolean): void {
		this.isRaw = enabled;
		this.rawModes.push(enabled);
	}

	setEncoding(encoding: BufferEncoding): void {
		this.encoding = encoding;
	}

	resume(): void {
		this.resumed = true;
	}

	pause(): void {
		this.paused = true;
	}

	on(event: "data", listener: (chunk: string | Uint8Array) => void): void {
		if (event === "data") this.#dataListeners.add(listener);
	}

	off(event: "data", listener: (chunk: string | Uint8Array) => void): void {
		if (event === "data") this.#dataListeners.delete(listener);
	}

	read(): string | Buffer | null {
		this.readCalls++;
		if (this.readError) throw this.readError;
		return this.queuedReads.shift() ?? null;
	}

	emitData(chunk: string): void {
		for (const listener of [...this.#dataListeners]) listener(chunk);
	}

	get listenerCount(): number {
		return this.#dataListeners.size;
	}
}

class FakeOutput implements ProcessTerminalOutput {
	isTTY = true;
	columns: number | undefined = 80;
	rows: number | undefined = 24;
	colorDepth = 24;
	deferCallbacks = false;
	readonly writes: string[] = [];
	readonly #callbacks: Array<() => void> = [];
	readonly #resizeListeners = new Set<() => void>();

	write(data: string, callback?: () => void): boolean {
		this.writes.push(data);
		if (callback) {
			if (this.deferCallbacks) this.#callbacks.push(callback);
			else callback();
		}
		return true;
	}

	on(event: "resize", listener: () => void): void {
		if (event === "resize") this.#resizeListeners.add(listener);
	}

	off(event: "resize", listener: () => void): void {
		if (event === "resize") this.#resizeListeners.delete(listener);
	}

	getColorDepth(): number {
		return this.colorDepth;
	}

	emitResize(): void {
		for (const listener of [...this.#resizeListeners]) listener();
	}

	completeWrites(): void {
		for (const callback of this.#callbacks.splice(0)) callback();
	}

	get output(): string {
		return this.writes.join("");
	}

	get listenerCount(): number {
		return this.#resizeListeners.size;
	}
}

function create(
	options: { noColor?: boolean; input?: FakeInput; output?: FakeOutput; colorScheme?: "auto" | "light" | "dark" } = {},
) {
	const input = options.input ?? new FakeInput();
	const output = options.output ?? new FakeOutput();
	const scheduler = new ManualScheduler();
	const diagnostics = vi.fn<DiagnosticSink>();
	const terminal = new ProcessTerminal({
		diagnostics,
		environment: options.noColor ? { NO_COLOR: "1" } : {},
		input,
		output,
		scheduler,
		synchronizedOutput: true,
		colorScheme: options.colorScheme ?? "dark",
	});
	return { diagnostics, input, output, scheduler, terminal };
}

async function startWithKitty(result: ReturnType<typeof create>): Promise<void> {
	const starting = result.terminal.start();
	await Promise.resolve();
	result.input.emitData("\x1b[?7u");
	await starting;
}

describe("ProcessTerminal lifecycle and capabilities", () => {
	it("resolves auto appearance from an OSC 11 response before start completes", async () => {
		const result = create({ colorScheme: "auto" });
		const starting = result.terminal.start();
		await Promise.resolve();

		expect(result.output.output).toContain("\x1b]11;?\x1b\\");
		result.input.emitData("\x1b[?7u\x1b]11;rgb:ffff/ffff/ffff\x1b\\");
		await starting;

		expect(result.terminal.capabilities.appearance).toBe("light");
		expect(Object.isFrozen(result.terminal.capabilities)).toBe(true);
		expect(result.diagnostics).not.toHaveBeenCalledWith(expect.objectContaining({ code: "terminal.unknown-input" }));
	});

	it("accepts a BEL-terminated OSC 11 response", async () => {
		const result = create({ colorScheme: "auto" });
		const starting = result.terminal.start();
		await Promise.resolve();
		result.input.emitData("\x1b[?7u\x1b]11;rgb:0000/0000/0000\x07");
		await starting;

		expect(result.terminal.capabilities.appearance).toBe("dark");
		await result.terminal.stop();
	});

	it("keeps the startup appearance across stop/start instead of querying as a live Theme switch", async () => {
		const result = create({ colorScheme: "auto" });
		const firstStart = result.terminal.start();
		await Promise.resolve();
		result.input.emitData("\x1b[?7u\x1b]11;rgb:ffff/ffff/ffff\x1b\\");
		await firstStart;
		await result.terminal.stop();

		const secondStart = result.terminal.start();
		await Promise.resolve();
		const restartNegotiation = result.scheduler.tasks.at(-1);
		result.input.emitData("\x1b[?7u");

		expect(restartNegotiation?.cancelled).toBe(true);
		expect(result.output.output.split("\x1b]11;?")).toHaveLength(2);
		expect(result.terminal.capabilities.appearance).toBe("light");
		await expect(secondStart).resolves.toBe(true);
		await result.terminal.stop();
	});

	it("falls back to unknown appearance after malformed and timed-out OSC 11 responses", async () => {
		const result = create({ colorScheme: "auto" });
		const starting = result.terminal.start();
		await Promise.resolve();
		result.input.emitData("\x1b[?7u\x1b]11;not-a-color\x07");

		await result.scheduler.runNext();
		await starting;

		expect(result.terminal.capabilities.appearance).toBe("unknown");
		expect(result.diagnostics).toHaveBeenCalledWith(
			expect.objectContaining({ code: "terminal.invalid-background-response" }),
		);

		result.input.emitData("\x1b]11;rgb:0000/0000/0000\x07");
		await result.terminal.flush();
		expect(result.terminal.capabilities.appearance).toBe("unknown");
	});

	it("bounds an unterminated OSC response so later keyboard input is not trapped", async () => {
		const result = create({ colorScheme: "auto" });
		const inputs: TerminalInput[] = [];
		result.terminal.onInput((input) => {
			inputs.push(input);
		});
		const starting = result.terminal.start();
		await Promise.resolve();
		const negotiation = result.scheduler.tasks.at(-1);
		result.input.emitData(`\x1b[?7u\x1b]11;rgb:${"f".repeat(5_000)}`);
		await negotiation?.run();
		await starting;

		result.input.emitData("y");
		await result.terminal.flush();

		expect(inputs).toContainEqual(expect.objectContaining({ type: "key", key: "y", text: "y" }));
		expect(result.diagnostics).toHaveBeenCalledWith(
			expect.objectContaining({ code: "terminal.escape-sequence-too-long" }),
		);
	});

	it("uses an explicit appearance without sending an OSC 11 query", async () => {
		const result = create({ colorScheme: "light" });

		await startWithKitty(result);

		expect(result.terminal.capabilities.appearance).toBe("light");
		expect(result.output.output).not.toContain("\x1b]11;?");
	});

	it("negotiates Kitty capabilities before start resolves", async () => {
		const result = create();

		await startWithKitty(result);

		expect(result.terminal.started).toBe(true);
		expect(result.input.rawModes).toEqual([true]);
		expect(result.output.output).toContain("\x1b[?25l");
		expect(result.output.output).toContain("\x1b[?2004h");
		expect(result.output.output).toContain("\x1b[>7u\x1b[?u");
		expect(result.terminal.capabilities).toEqual({
			appearance: "dark",
			keyboardProtocol: "kitty",
			colorLevel: 3,
			synchronizedOutput: true,
			keyRelease: true,
			sizeFallback: false,
		});
		expect(Object.isFrozen(result.terminal.capabilities)).toBe(true);
	});

	it("falls back deterministically to press-only legacy input", async () => {
		const result = create();
		const starting = result.terminal.start();
		await Promise.resolve();

		await result.scheduler.runNext();
		await starting;

		expect(result.terminal.capabilities.keyboardProtocol).toBe("legacy");
		expect(result.terminal.capabilities.keyRelease).toBe(false);
	});

	it("does not touch streams when either side is not a TTY", async () => {
		const result = create();
		result.input.isTTY = false;

		expect(result.terminal.available).toBe(false);
		await expect(result.terminal.start()).resolves.toBe(false);
		expect(result.input.rawModes).toEqual([]);
		expect(result.input.listenerCount).toBe(0);
		expect(result.output.output).toBe("");
	});

	it("does not claim to start when raw mode cannot be enabled", async () => {
		const output = new FakeOutput();
		const input: ProcessTerminalInput = {
			isTTY: true,
			on: () => {},
			off: () => {},
		};
		const terminal = new ProcessTerminal({ environment: {}, input, output, scheduler: new ManualScheduler() });

		expect(terminal.available).toBe(false);
		await expect(terminal.start()).resolves.toBe(false);
		expect(output.output).toBe("");
	});

	it("uses an immutable 80x24 fallback, reports it, and accepts later resize", async () => {
		const output = new FakeOutput();
		output.columns = undefined;
		output.rows = undefined;
		const result = create({ output });
		const inputs: TerminalInput[] = [];
		result.terminal.onInput((input) => {
			inputs.push(input);
		});
		await startWithKitty(result);

		expect(result.terminal.size).toEqual({ columns: 80, rows: 24 });
		expect(result.terminal.capabilities.sizeFallback).toBe(true);
		expect(result.diagnostics).toHaveBeenCalledWith(expect.objectContaining({ code: "terminal.unknown-size" }));
		output.columns = 120;
		output.rows = 40;
		output.emitResize();
		await result.terminal.flush();

		expect(inputs).toEqual([{ type: "resize", columns: 120, rows: 40 }]);
		expect(result.terminal.size).toEqual({ columns: 120, rows: 40 });
		expect(result.terminal.capabilities.sizeFallback).toBe(false);
		expect(Object.isFrozen(result.terminal.size)).toBe(true);
	});

	it("honors NO_COLOR and makes flush wait for pending output callbacks", async () => {
		const result = create({ noColor: true });
		await startWithKitty(result);
		expect(result.terminal.capabilities.colorLevel).toBe(0);

		result.output.deferCallbacks = true;
		result.terminal.write("pending");
		let flushed = false;
		const flushing = result.terminal.flush().then(() => {
			flushed = true;
		});
		await Promise.resolve();
		expect(flushed).toBe(false);
		result.output.completeWrites();
		await flushing;
		expect(flushed).toBe(true);
	});

	it("can flush rendered output from inside an input handler without awaiting that handler", async () => {
		const result = create();
		await startWithKitty(result);
		result.output.deferCallbacks = true;
		let rendered = false;
		result.terminal.onInput(async (input) => {
			if (input.type !== "resize") return;
			result.terminal.write("resized frame");
			await result.terminal.flushOutput();
			rendered = true;
		});

		result.output.columns = 101;
		result.output.rows = 31;
		result.output.emitResize();
		await Promise.resolve();
		expect(rendered).toBe(false);

		result.output.completeWrites();
		await result.terminal.flush();
		expect(rendered).toBe(true);
	});

	it("drains and restores every protocol and listener on idempotent stop", async () => {
		const result = create();
		await startWithKitty(result);
		result.input.queuedReads.push("late-release");

		await result.terminal.stop();
		await result.terminal.stop();

		expect(result.input.readCalls).toBeGreaterThanOrEqual(2);
		expect(result.input.rawModes).toEqual([true, false]);
		expect(result.input.listenerCount).toBe(0);
		expect(result.output.listenerCount).toBe(0);
		expect(result.output.output).toContain("\x1b[<u");
		expect(result.output.output).toContain("\x1b[?2004l");
		expect(result.output.output).toContain("\x1b[?25h");
		expect(result.terminal.started).toBe(false);
	});

	it("restores state even when draining input fails", async () => {
		const result = create();
		await startWithKitty(result);
		result.input.readError = new Error("read failed");

		await expect(result.terminal.stop()).rejects.toThrow("read failed");

		expect(result.input.rawModes).toEqual([true, false]);
		expect(result.input.listenerCount).toBe(0);
		expect(result.output.listenerCount).toBe(0);
		expect(result.output.output).toContain("\x1b[?25h");
		expect(result.terminal.started).toBe(false);
	});

	it("coalesces concurrent stop calls made while start is negotiating", async () => {
		const result = create();
		const starting = result.terminal.start();
		const firstStop = result.terminal.stop();
		const secondStop = result.terminal.stop();

		await Promise.all([starting, firstStop, secondStop]);

		expect(result.input.rawModes).toEqual([true, false]);
		expect(result.output.output.split("\x1b[?2004l")).toHaveLength(2);
	});
});

describe("ProcessTerminal structured input", () => {
	it("normalizes SGR mouse press, release, and hover coordinates", async () => {
		const result = create();
		const inputs: TerminalInput[] = [];
		result.terminal.onInput((input) => {
			inputs.push(input);
		});
		await startWithKitty(result);

		result.input.emitData("\x1b[<0;12;7M\x1b[<0;12;7m\x1b[<35;20;9M");
		await result.terminal.flush();

		expect(inputs).toEqual([
			{
				type: "mouse",
				action: "press",
				button: "left",
				column: 11,
				row: 6,
				shift: false,
				control: false,
				alt: false,
			},
			expect.objectContaining({ type: "mouse", action: "release", button: "left", column: 11, row: 6 }),
			expect.objectContaining({ type: "mouse", action: "move", button: "none", column: 19, row: 8 }),
		]);
	});

	it("normalizes SGR mouse wheel input", async () => {
		const result = create();
		const inputs: TerminalInput[] = [];
		result.terminal.onInput((input) => {
			inputs.push(input);
		});
		await startWithKitty(result);

		result.input.emitData("\x1b[<64;12;7M\x1b[<65;12;7M");
		await result.terminal.flush();

		expect(inputs).toEqual([
			expect.objectContaining({ type: "mouse", action: "press", button: "wheel-up", column: 11, row: 6 }),
			expect.objectContaining({ type: "mouse", action: "press", button: "wheel-down", column: 11, row: 6 }),
		]);
	});

	it("emits one PasteInput even when bracketed paste spans chunks", async () => {
		const result = create();
		const inputs: TerminalInput[] = [];
		result.terminal.onInput((input) => {
			inputs.push(input);
		});
		await startWithKitty(result);

		result.input.emitData("\x1b[200~one\n");
		result.input.emitData("two\x1b[201~");
		await result.terminal.flush();

		expect(inputs).toEqual([{ type: "paste", text: "one\ntwo" }]);
	});

	it("normalizes Kitty, legacy, text, and batched input in source order", async () => {
		const result = create();
		const inputs: TerminalInput[] = [];
		result.terminal.onInput(async (input) => {
			await Promise.resolve();
			inputs.push(input);
		});
		await startWithKitty(result);

		result.input.emitData("a\x1b[A");
		result.input.emitData("\x1b[107;5u");
		result.input.emitData("你好");
		await result.terminal.flush();

		expect(inputs).toEqual([
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
			expect.objectContaining({ type: "key", key: "up", action: "press" }),
			expect.objectContaining({ type: "key", key: "k", control: true, action: "press" }),
			{ type: "text", text: "你好" },
		]);
	});

	it("normalizes application-cursor arrows used by legacy terminals", async () => {
		const result = create();
		const inputs: TerminalInput[] = [];
		result.terminal.onInput((input) => {
			inputs.push(input);
		});
		await startWithKitty(result);

		result.input.emitData("\x1bO");
		result.input.emitData("A\x1bOB");
		await result.terminal.flush();

		expect(inputs).toEqual([
			expect.objectContaining({ type: "key", key: "up", action: "press" }),
			expect.objectContaining({ type: "key", key: "down", action: "press" }),
		]);
		expect(result.diagnostics).not.toHaveBeenCalled();
	});

	it("normalizes eventful Kitty cursor keys emitted by Ghostty", async () => {
		const result = create();
		const inputs: TerminalInput[] = [];
		result.terminal.onInput((input) => {
			inputs.push(input);
		});
		await startWithKitty(result);

		result.input.emitData("\x1b[1;1:1A\x1b[1;1:3A\x1b[1;1:1B\x1b[1;1:3B");
		await result.terminal.flush();

		expect(inputs).toEqual([
			expect.objectContaining({ type: "key", key: "up", action: "press" }),
			expect.objectContaining({ type: "key", key: "up", action: "release" }),
			expect.objectContaining({ type: "key", key: "down", action: "press" }),
			expect.objectContaining({ type: "key", key: "down", action: "release" }),
		]);
		expect(result.diagnostics).not.toHaveBeenCalled();
	});

	it("keeps Alt+Shift+O distinct from a split application-cursor sequence", async () => {
		const result = create();
		const inputs: TerminalInput[] = [];
		result.terminal.onInput((input) => {
			inputs.push(input);
		});
		await startWithKitty(result);

		result.input.emitData("\x1bO");
		await result.scheduler.runNext();
		await result.terminal.flush();

		expect(inputs).toEqual([
			expect.objectContaining({ type: "key", key: "o", shift: true, alt: true, action: "press" }),
		]);
	});

	it("normalizes xterm modifyOtherKeys Shift+Enter without a diagnostic", async () => {
		const result = create();
		const inputs: TerminalInput[] = [];
		result.terminal.onInput((input) => {
			inputs.push(input);
		});
		await startWithKitty(result);

		result.input.emitData("\x1b[27;2;");
		result.input.emitData("13~");
		await result.terminal.flush();

		expect(inputs).toEqual([
			expect.objectContaining({
				type: "key",
				key: "enter",
				shift: true,
				control: false,
				alt: false,
				meta: false,
				action: "press",
			}),
		]);
		expect(result.diagnostics).not.toHaveBeenCalled();
	});

	it("decodes every xterm modifier bit combination", async () => {
		const result = create();
		const inputs: TerminalInput[] = [];
		result.terminal.onInput((input) => {
			inputs.push(input);
		});
		await startWithKitty(result);

		result.input.emitData(Array.from({ length: 16 }, (_, index) => `\x1b[27;${index + 1};13~`).join(""));
		await result.terminal.flush();

		expect(inputs).toHaveLength(16);
		for (const [index, input] of inputs.entries()) {
			const bits = index;
			expect(input).toEqual(
				expect.objectContaining({
					type: "key",
					key: "enter",
					shift: (bits & 1) !== 0,
					alt: (bits & 2) !== 0,
					control: (bits & 4) !== 0,
					meta: (bits & 8) !== 0,
				}),
			);
		}
		expect(result.diagnostics).not.toHaveBeenCalled();
	});

	it("delivers an xterm multiline draft through ProcessTerminal into Editor", async () => {
		const result = create();
		const editor = new Editor();
		result.terminal.onInput((input) => {
			editor.handleInput(input);
		});
		await startWithKitty(result);

		result.input.emitData("hello\x1b[27;2;13~coda");
		await result.terminal.flush();

		expect(editor.text).toBe("hello\ncoda");
		expect(result.diagnostics).not.toHaveBeenCalled();
	});

	it("normalizes xterm modifyOtherKeys special keys and insertable codepoints", async () => {
		const result = create();
		const inputs: TerminalInput[] = [];
		result.terminal.onInput((input) => {
			inputs.push(input);
		});
		await startWithKitty(result);

		result.input.emitData(
			"\x1b[27;2;9~\x1b[27;3;27~\x1b[27;5;127~\x1b[27;9;13~\x1b[27;6;13~\x1b[27;1;32~\x1b[27;2;97~\x1b[27;1;20320~",
		);
		await result.terminal.flush();

		expect(inputs).toEqual([
			expect.objectContaining({ type: "key", key: "tab", shift: true }),
			expect.objectContaining({ type: "key", key: "escape", alt: true }),
			expect.objectContaining({ type: "key", key: "backspace", control: true }),
			expect.objectContaining({ type: "key", key: "enter", meta: true }),
			expect.objectContaining({ type: "key", key: "enter", shift: true, control: true }),
			expect.objectContaining({ type: "key", key: "space", text: " " }),
			expect.objectContaining({ type: "key", key: "a", shift: true, text: "A" }),
			{ type: "text", text: "你" },
		]);
		expect(result.diagnostics).not.toHaveBeenCalled();
	});

	it("diagnoses invalid xterm modifyOtherKeys fields without emitting input", async () => {
		const result = create();
		const inputs: TerminalInput[] = [];
		result.terminal.onInput((input) => {
			inputs.push(input);
		});
		await startWithKitty(result);
		const invalid = ["\x1b[27;0;13~", "\x1b[27;17;13~", "\x1b[27;1;0~", "\x1b[27;1;55296~", "\x1b[27;1;1114112~"];

		result.input.emitData(invalid.join(""));
		await result.terminal.flush();

		expect(inputs).toEqual([]);
		expect(result.diagnostics.mock.calls.map(([diagnostic]) => diagnostic)).toEqual(
			invalid.map((sequence) => expect.objectContaining({ code: "terminal.unknown-input", details: { sequence } })),
		);
	});

	it("uses Kitty text-as-codepoints and omits non-insertable modifier text", async () => {
		const result = create();
		const inputs: TerminalInput[] = [];
		result.terminal.onInput((input) => {
			inputs.push(input);
		});
		await startWithKitty(result);

		result.input.emitData("\x1b[97:65:97;2;65u");
		result.input.emitData("\x1b[107;5u");
		result.input.emitData("\x1b[120;3u");
		result.input.emitData("\x1b[97;1:3;97u");
		await result.terminal.flush();

		expect(inputs).toEqual([
			expect.objectContaining({ type: "key", key: "a", shift: true, text: "A", action: "press" }),
			expect.not.objectContaining({ text: expect.anything() }),
			expect.not.objectContaining({ text: expect.anything() }),
			expect.not.objectContaining({ text: expect.anything() }),
		]);
	});

	it("keeps release actions instance-local and diagnoses unknown CSI", async () => {
		const result = create();
		const inputs: TerminalInput[] = [];
		result.terminal.onInput((input) => {
			inputs.push(input);
		});
		await startWithKitty(result);

		result.input.emitData("\x1b[97;2:3u");
		result.input.emitData("\x1b[999~");
		await result.terminal.flush();

		expect(inputs).toEqual([expect.objectContaining({ type: "key", key: "a", shift: true, action: "release" })]);
		expect(result.diagnostics).toHaveBeenCalledWith(
			expect.objectContaining({ code: "terminal.unknown-input", details: { sequence: "\x1b[999~" } }),
		);
	});

	it("does not report release events after legacy fallback", async () => {
		const result = create();
		const inputs: TerminalInput[] = [];
		result.terminal.onInput((input) => {
			inputs.push(input);
		});
		const starting = result.terminal.start();
		await Promise.resolve();
		await result.scheduler.runNext();
		await starting;

		result.input.emitData("\x1b[97;1:3u");
		await result.terminal.flush();

		expect(inputs).toEqual([]);
	});

	it("distinguishes a split CSI sequence from a standalone Escape key", async () => {
		const result = create();
		const inputs: TerminalInput[] = [];
		result.terminal.onInput((input) => {
			inputs.push(input);
		});
		await startWithKitty(result);

		result.input.emitData("\x1b");
		result.input.emitData("[A");
		await result.terminal.flush();
		expect(inputs).toEqual([expect.objectContaining({ type: "key", key: "up" })]);

		result.input.emitData("\x1b");
		await result.scheduler.runNext();
		await result.terminal.flush();
		expect(inputs.at(-1)).toEqual(expect.objectContaining({ type: "key", key: "escape" }));
	});
});
