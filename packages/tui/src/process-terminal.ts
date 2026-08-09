import { Buffer } from "node:buffer";
import type { Diagnostic, DiagnosticSink } from "./diagnostics.ts";
import type { KeyAction, KeyInput, LogicalKey, MouseInput, TerminalInput } from "./input.ts";
import type { ScheduledTask, Scheduler } from "./runtime.ts";
import {
	type ColorLevel,
	type Terminal,
	type TerminalCapabilities,
	type TerminalInputListener,
	type TerminalSize,
	terminalCapabilities,
	terminalSize,
} from "./terminal.ts";

const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";
const KITTY_FLAGS = 7;
const KITTY_QUERY = `\x1b[>${KITTY_FLAGS}u\x1b[?u`;
const START_SEQUENCES = `\x1b[?25l\x1b[?2004h${KITTY_QUERY}`;
const STOP_SEQUENCES = "\x1b[<u\x1b[?2004l\x1b[?25h";
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export interface ProcessTerminalInput {
	readonly isTTY?: boolean;
	readonly isRaw?: boolean;
	setRawMode?(enabled: boolean): void;
	setEncoding?(encoding: BufferEncoding): void;
	resume?(): void;
	pause?(): void;
	on(event: "data", listener: (chunk: string | Uint8Array) => void): unknown;
	off(event: "data", listener: (chunk: string | Uint8Array) => void): unknown;
	read?(): string | Uint8Array | null;
}

export interface ProcessTerminalOutput {
	readonly isTTY?: boolean;
	readonly columns?: number;
	readonly rows?: number;
	write(data: string, callback?: () => void): boolean;
	on(event: "resize", listener: () => void): unknown;
	off(event: "resize", listener: () => void): unknown;
	getColorDepth?(): number;
}

export interface ProcessTerminalOptions {
	readonly input: ProcessTerminalInput;
	readonly output: ProcessTerminalOutput;
	readonly environment: Readonly<Record<string, string | undefined>>;
	readonly scheduler: Scheduler;
	readonly diagnostics?: DiagnosticSink;
	readonly synchronizedOutput?: boolean;
	readonly keyboardNegotiationTimeoutMs?: number;
	readonly escapeSequenceTimeoutMs?: number;
}

interface Modifiers {
	readonly shift: boolean;
	readonly control: boolean;
	readonly alt: boolean;
	readonly meta: boolean;
}

const NO_MODIFIERS: Modifiers = {
	shift: false,
	control: false,
	alt: false,
	meta: false,
};

const PUNCTUATION = new Map<string, { key: LogicalKey; shift: boolean }>([
	["`", { key: "backtick", shift: false }],
	["~", { key: "tilde", shift: true }],
	["-", { key: "hyphen", shift: false }],
	["_", { key: "underscore", shift: true }],
	["=", { key: "equals", shift: false }],
	["+", { key: "plus", shift: true }],
	["[", { key: "left-bracket", shift: false }],
	["{", { key: "left-brace", shift: true }],
	["]", { key: "right-bracket", shift: false }],
	["}", { key: "right-brace", shift: true }],
	["\\", { key: "backslash", shift: false }],
	["|", { key: "pipe", shift: true }],
	[";", { key: "semicolon", shift: false }],
	[":", { key: "colon", shift: true }],
	["'", { key: "apostrophe", shift: false }],
	[",", { key: "comma", shift: false }],
	["<", { key: "less-than", shift: true }],
	[".", { key: "period", shift: false }],
	[">", { key: "greater-than", shift: true }],
	["/", { key: "slash", shift: false }],
	["?", { key: "question", shift: true }],
	["!", { key: "exclamation", shift: true }],
	["@", { key: "at", shift: true }],
	["#", { key: "hash", shift: true }],
	["$", { key: "dollar", shift: true }],
	["%", { key: "percent", shift: true }],
	["^", { key: "caret", shift: true }],
	["&", { key: "ampersand", shift: true }],
	["*", { key: "asterisk", shift: true }],
	["(", { key: "left-parenthesis", shift: true }],
	[")", { key: "right-parenthesis", shift: true }],
]);

const LEGACY_KEYS = new Map<string, LogicalKey>([
	["\x1b[A", "up"],
	["\x1b[B", "down"],
	["\x1b[C", "right"],
	["\x1b[D", "left"],
	["\x1b[H", "home"],
	["\x1b[F", "end"],
	["\x1b[1~", "home"],
	["\x1b[2~", "insert"],
	["\x1b[3~", "delete"],
	["\x1b[4~", "end"],
	["\x1b[5~", "page-up"],
	["\x1b[6~", "page-down"],
	["\x1bOP", "f1"],
	["\x1bOQ", "f2"],
	["\x1bOR", "f3"],
	["\x1bOS", "f4"],
	["\x1b[15~", "f5"],
	["\x1b[17~", "f6"],
	["\x1b[18~", "f7"],
	["\x1b[19~", "f8"],
	["\x1b[20~", "f9"],
	["\x1b[21~", "f10"],
	["\x1b[23~", "f11"],
	["\x1b[24~", "f12"],
]);

const KITTY_FUNCTIONAL_KEYS = new Map<number, LogicalKey>([
	[57348, "insert"],
	[57349, "delete"],
	[57350, "left"],
	[57351, "right"],
	[57352, "up"],
	[57353, "down"],
	[57354, "page-up"],
	[57355, "page-down"],
	[57356, "home"],
	[57357, "end"],
	[57364, "f1"],
	[57365, "f2"],
	[57366, "f3"],
	[57367, "f4"],
	[57368, "f5"],
	[57369, "f6"],
	[57370, "f7"],
	[57371, "f8"],
	[57372, "f9"],
	[57373, "f10"],
	[57374, "f11"],
	[57375, "f12"],
]);

export class ProcessTerminal implements Terminal {
	readonly #input: ProcessTerminalInput;
	readonly #output: ProcessTerminalOutput;
	readonly #environment: Readonly<Record<string, string | undefined>>;
	readonly #scheduler: Scheduler;
	readonly #diagnostics?: DiagnosticSink;
	readonly #synchronizedOutput: boolean;
	readonly #negotiationTimeoutMs: number;
	readonly #escapeSequenceTimeoutMs: number;
	readonly #listeners = new Set<TerminalInputListener>();
	readonly #dataListener = (chunk: string | Uint8Array): void => this.#receive(chunk);
	readonly #resizeListener = (): void => this.#receiveResize();
	#size: TerminalSize;
	#capabilities: TerminalCapabilities;
	#usedFallbackSize: boolean;
	#started = false;
	#starting = false;
	#startPromise?: Promise<boolean>;
	#stopPromise?: Promise<void>;
	#wasRaw = false;
	#rawBuffer = "";
	#dispatchTail: Promise<void> = Promise.resolve();
	#pendingWrites = 0;
	readonly #writeWaiters = new Set<() => void>();
	#negotiationTask?: ScheduledTask;
	#escapeTask?: ScheduledTask;
	#resolveNegotiation?: () => void;

	constructor(options: ProcessTerminalOptions) {
		this.#input = options.input;
		this.#output = options.output;
		this.#environment = options.environment;
		this.#scheduler = options.scheduler;
		this.#diagnostics = options.diagnostics;
		this.#synchronizedOutput = options.synchronizedOutput ?? false;
		this.#negotiationTimeoutMs = options.keyboardNegotiationTimeoutMs ?? 100;
		this.#escapeSequenceTimeoutMs = options.escapeSequenceTimeoutMs ?? 10;
		const initialSize = readSize(options.output);
		this.#usedFallbackSize = initialSize === undefined;
		this.#size = initialSize ?? terminalSize(DEFAULT_COLUMNS, DEFAULT_ROWS);
		this.#capabilities = this.#createCapabilities("legacy");
	}

	get available(): boolean {
		return this.#input.isTTY === true && this.#output.isTTY === true && typeof this.#input.setRawMode === "function";
	}

	get started(): boolean {
		return this.#started;
	}

	get size(): TerminalSize {
		return this.#size;
	}

	get capabilities(): TerminalCapabilities {
		return this.#capabilities;
	}

	async start(): Promise<boolean> {
		if (this.#stopPromise) await this.#stopPromise;
		if (this.#started) return true;
		if (this.#startPromise) return this.#startPromise;
		this.#startPromise = this.#performStart();
		try {
			return await this.#startPromise;
		} finally {
			this.#startPromise = undefined;
		}
	}

	async #performStart(): Promise<boolean> {
		const setRawMode = this.#input.setRawMode;
		if (!this.available || !setRawMode) return false;
		this.#starting = true;
		this.#wasRaw = this.#input.isRaw ?? false;
		try {
			this.#input.on("data", this.#dataListener);
			this.#output.on("resize", this.#resizeListener);
			setRawMode.call(this.#input, true);
			this.#input.setEncoding?.("utf8");
			this.#input.resume?.();
			if (this.#usedFallbackSize) {
				this.#queueDiagnostic({
					code: "terminal.unknown-size",
					message: `Terminal size is unavailable; using ${DEFAULT_COLUMNS}x${DEFAULT_ROWS} until resize`,
					details: { columns: DEFAULT_COLUMNS, rows: DEFAULT_ROWS },
				});
			}

			const negotiation = this.#beginNegotiation();
			this.write(START_SEQUENCES);
			await Promise.all([negotiation, this.flushOutput()]);
			this.#started = true;
			return true;
		} catch (error) {
			await this.#restoreAfterFailure();
			throw error;
		} finally {
			this.#starting = false;
		}
	}

	#beginNegotiation(): Promise<void> {
		return new Promise<void>((resolve) => {
			this.#resolveNegotiation = resolve;
			this.#negotiationTask = this.#scheduler.schedule(this.#negotiationTimeoutMs, () => {
				this.#settleNegotiation("legacy");
			});
		});
	}

	#settleNegotiation(protocol: "kitty" | "legacy"): void {
		if (!this.#resolveNegotiation) return;
		this.#negotiationTask?.cancel();
		this.#negotiationTask = undefined;
		this.#capabilities = this.#createCapabilities(protocol);
		const resolve = this.#resolveNegotiation;
		this.#resolveNegotiation = undefined;
		resolve();
	}

	#createCapabilities(protocol: "kitty" | "legacy"): TerminalCapabilities {
		return terminalCapabilities({
			keyboardProtocol: protocol,
			colorLevel: detectColorLevel(this.#output, this.#environment),
			synchronizedOutput: this.#synchronizedOutput,
			keyRelease: protocol === "kitty",
			sizeFallback: this.#usedFallbackSize,
		});
	}

	async stop(): Promise<void> {
		if (this.#stopPromise) return this.#stopPromise;
		this.#stopPromise = this.#settleStartAndStop();
		try {
			await this.#stopPromise;
		} finally {
			this.#stopPromise = undefined;
		}
	}

	async #settleStartAndStop(): Promise<void> {
		if (this.#startPromise && !this.#started) {
			this.#settleNegotiation("legacy");
			try {
				await this.#startPromise;
			} catch {
				return;
			}
		}
		if (!this.#started && !this.#starting) return;
		await this.#performStop();
	}

	async #performStop(): Promise<void> {
		let failure: unknown;
		try {
			await this.#dispatchTail;
		} catch (error) {
			failure = error;
		} finally {
			this.#settleNegotiation("legacy");
			this.#escapeTask?.cancel();
			this.#escapeTask = undefined;
			try {
				this.#drainInput();
			} catch (error) {
				failure ??= error;
			}
			try {
				this.#input.off("data", this.#dataListener);
			} catch (error) {
				failure ??= error;
			}
			try {
				this.#output.off("resize", this.#resizeListener);
			} catch (error) {
				failure ??= error;
			}
			try {
				this.write(STOP_SEQUENCES);
				await this.#waitForWrites();
			} catch (error) {
				failure ??= error;
			} finally {
				try {
					this.#input.setRawMode?.(this.#wasRaw);
				} catch (error) {
					failure ??= error;
				}
				try {
					this.#input.pause?.();
				} catch (error) {
					failure ??= error;
				}
				this.#started = false;
				this.#starting = false;
				this.#rawBuffer = "";
			}
		}
		if (failure !== undefined) throw failure;
	}

	async #restoreAfterFailure(): Promise<void> {
		this.#settleNegotiation("legacy");
		this.#escapeTask?.cancel();
		this.#escapeTask = undefined;
		try {
			this.#input.off("data", this.#dataListener);
		} catch {
			// Continue restoring the remaining terminal state.
		}
		try {
			this.#output.off("resize", this.#resizeListener);
		} catch {
			// Continue restoring the remaining terminal state.
		}
		try {
			this.write(STOP_SEQUENCES);
			await this.#waitForWrites();
		} catch {
			// Preserve the start failure while still restoring input state.
		} finally {
			try {
				this.#input.setRawMode?.(this.#wasRaw);
			} catch {
				// Preserve the start failure.
			}
			try {
				this.#input.pause?.();
			} catch {
				// Preserve the start failure.
			}
			this.#started = false;
		}
	}

	#drainInput(): void {
		if (!this.#input.read) return;
		for (let reads = 0; reads < 1024; reads++) {
			if (this.#input.read() === null) return;
		}
		this.#queueDiagnostic({
			code: "terminal.input-drain-limit",
			message: "Stopped draining terminal input after 1024 queued chunks",
		});
	}

	write(data: string): void {
		this.#pendingWrites++;
		let finished = false;
		const complete = (): void => {
			if (finished) return;
			finished = true;
			this.#pendingWrites--;
			if (this.#pendingWrites === 0) {
				for (const resolve of this.#writeWaiters) resolve();
				this.#writeWaiters.clear();
			}
		};
		try {
			this.#output.write(data, complete);
		} catch (error) {
			complete();
			throw error;
		}
	}

	async flush(): Promise<void> {
		while (true) {
			const dispatch = this.#dispatchTail;
			await dispatch;
			await this.flushOutput();
			if (dispatch === this.#dispatchTail && this.#pendingWrites === 0) return;
		}
	}

	async flushOutput(): Promise<void> {
		await this.#waitForWrites();
	}

	#waitForWrites(): Promise<void> {
		if (this.#pendingWrites === 0) return Promise.resolve();
		return new Promise<void>((resolve) => this.#writeWaiters.add(resolve));
	}

	onInput(listener: TerminalInputListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#receive(chunk: string | Uint8Array): void {
		this.#escapeTask?.cancel();
		this.#escapeTask = undefined;
		this.#rawBuffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		this.#parseBuffer();
	}

	#parseBuffer(): void {
		while (this.#rawBuffer.length > 0) {
			if (this.#rawBuffer === "\x1b") {
				this.#escapeTask ??= this.#scheduler.schedule(this.#escapeSequenceTimeoutMs, () => {
					this.#escapeTask = undefined;
					if (this.#rawBuffer === "\x1b") {
						this.#rawBuffer = "";
						this.#parseEscape("\x1b");
					} else {
						this.#parseBuffer();
					}
				});
				return;
			}
			if (this.#rawBuffer.startsWith(BRACKETED_PASTE_START)) {
				const end = this.#rawBuffer.indexOf(BRACKETED_PASTE_END, BRACKETED_PASTE_START.length);
				if (end < 0) return;
				const text = this.#rawBuffer.slice(BRACKETED_PASTE_START.length, end);
				this.#rawBuffer = this.#rawBuffer.slice(end + BRACKETED_PASTE_END.length);
				this.#queueInput({ type: "paste", text });
				continue;
			}

			if (this.#rawBuffer[0] !== "\x1b") {
				const nextEscape = this.#rawBuffer.indexOf("\x1b");
				const end = nextEscape < 0 ? this.#rawBuffer.length : nextEscape;
				const plain = this.#rawBuffer.slice(0, end);
				this.#rawBuffer = this.#rawBuffer.slice(end);
				this.#parsePlain(plain);
				continue;
			}

			const sequence = readEscapeSequence(this.#rawBuffer);
			if (!sequence) return;
			this.#rawBuffer = this.#rawBuffer.slice(sequence.length);
			this.#parseEscape(sequence);
		}
	}

	#parsePlain(text: string): void {
		let pendingText = "";
		const flushText = (): void => {
			if (!pendingText) return;
			this.#queueInput({ type: "text", text: pendingText });
			pendingText = "";
		};

		for (const { segment } of graphemes.segment(text)) {
			const key = keyFromPlainSegment(segment);
			if (key) {
				flushText();
				this.#queueInput(key);
			} else if ([...segment].some((character) => character.codePointAt(0)! < 0x20)) {
				flushText();
				this.#queueDiagnostic({
					code: "terminal.unknown-input",
					message: "Terminal emitted an unknown control character",
					details: { sequence: segment },
				});
			} else {
				pendingText += segment;
			}
		}
		flushText();
	}

	#parseEscape(sequence: string): void {
		const csi = sequence.startsWith("\x1b[") ? sequence.slice(2) : undefined;
		const negotiation = /^\?(\d+)u$/.exec(csi ?? "");
		if (negotiation) {
			this.#settleNegotiation(Number.parseInt(negotiation[1]!, 10) > 0 ? "kitty" : "legacy");
			return;
		}
		if (/^\?[\d;]*c$/.test(csi ?? "")) {
			this.#settleNegotiation("legacy");
			return;
		}

		const mouse = parseSgrMouse(sequence);
		if (mouse) {
			this.#queueInput(mouse);
			return;
		}

		const kitty = parseKittyKey(sequence);
		if (kitty) {
			if (!this.#capabilities.keyRelease && kitty.action !== "press") return;
			this.#queueInput(kitty);
			return;
		}
		const xtermModified = parseXtermModifiedKey(sequence);
		if (xtermModified) {
			this.#queueInput(xtermModified);
			return;
		}

		const legacy = LEGACY_KEYS.get(sequence);
		if (legacy) {
			this.#queueInput(keyInput(legacy));
			return;
		}
		if (sequence === "\x1b[Z") {
			this.#queueInput(keyInput("tab", undefined, { ...NO_MODIFIERS, shift: true }));
			return;
		}

		const modifiedLegacy = /^1;(\d+)([ABCDHF])$/.exec(csi ?? "");
		if (modifiedLegacy) {
			const names: Readonly<Record<string, LogicalKey>> = {
				A: "up",
				B: "down",
				C: "right",
				D: "left",
				H: "home",
				F: "end",
			};
			const key = names[modifiedLegacy[2]!];
			if (key) {
				this.#queueInput(keyInput(key, undefined, decodeModifiers(Number.parseInt(modifiedLegacy[1]!, 10))));
				return;
			}
		}

		if (sequence === "\x1b") {
			this.#queueInput(keyInput("escape"));
			return;
		}
		if (sequence.length === 2 && sequence.startsWith("\x1b")) {
			const altKey = keyFromPlainSegment(sequence[1]!);
			if (altKey) {
				this.#queueInput(
					keyInput(altKey.key, undefined, {
						shift: altKey.shift,
						control: altKey.control,
						alt: true,
						meta: altKey.meta,
					}),
				);
				return;
			}
		}

		this.#queueDiagnostic({
			code: "terminal.unknown-input",
			message: "Terminal emitted an unknown escape sequence",
			details: { sequence },
		});
	}

	#receiveResize(): void {
		const size = readSize(this.#output);
		if (!size) {
			this.#queueDiagnostic({
				code: "terminal.unknown-size",
				message: "Ignored a resize event without valid dimensions",
			});
			return;
		}
		this.#usedFallbackSize = false;
		this.#size = size;
		this.#capabilities = this.#createCapabilities(this.#capabilities.keyboardProtocol);
		this.#queueInput({ type: "resize", columns: size.columns, rows: size.rows });
	}

	#queueInput(input: TerminalInput): void {
		const snapshot = Object.freeze({ ...input }) as TerminalInput;
		this.#dispatchTail = this.#dispatchTail.then(async () => {
			for (const listener of this.#listeners) await listener(snapshot);
		});
		this.#dispatchTail = this.#dispatchTail.catch(async (error: unknown) => {
			await this.#emitDiagnostic({
				code: "terminal.input-listener-failure",
				message: error instanceof Error ? error.message : String(error),
			});
		});
	}

	#queueDiagnostic(diagnostic: Diagnostic): void {
		this.#dispatchTail = this.#dispatchTail.then(() => this.#emitDiagnostic(diagnostic));
	}

	async #emitDiagnostic(diagnostic: Diagnostic): Promise<void> {
		try {
			await this.#diagnostics?.(Object.freeze(diagnostic));
		} catch {
			// Diagnostics cannot alter terminal cleanup or input delivery.
		}
	}
}

function readSize(output: ProcessTerminalOutput): TerminalSize | undefined {
	const columns = output.columns;
	const rows = output.rows;
	if (!Number.isSafeInteger(columns) || !Number.isSafeInteger(rows) || columns === undefined || rows === undefined) {
		return undefined;
	}
	if (columns < 1 || rows < 1) return undefined;
	return terminalSize(columns, rows);
}

function detectColorLevel(
	output: ProcessTerminalOutput,
	environment: Readonly<Record<string, string | undefined>>,
): ColorLevel {
	if (environment.NO_COLOR !== undefined) return 0;
	const depth = output.getColorDepth?.() ?? 1;
	if (depth >= 24) return 3;
	if (depth >= 8) return 2;
	if (depth >= 4) return 1;
	return 0;
}

function readEscapeSequence(buffer: string): string | undefined {
	if (buffer === "\x1b") return buffer;
	const introducer = buffer[1];
	if (introducer === "[") {
		for (let index = 2; index < buffer.length; index++) {
			const code = buffer.charCodeAt(index);
			if (code >= 0x40 && code <= 0x7e) return buffer.slice(0, index + 1);
		}
		return undefined;
	}
	if (introducer === "]" || introducer === "_" || introducer === "P" || introducer === "^") {
		for (let index = 2; index < buffer.length; index++) {
			if (buffer.charCodeAt(index) === 0x07) return buffer.slice(0, index + 1);
			if (buffer.charCodeAt(index) === 0x1b && buffer[index + 1] === "\\") return buffer.slice(0, index + 2);
		}
		return undefined;
	}
	return buffer.slice(0, 2);
}

function keyFromPlainSegment(segment: string): KeyInput | undefined {
	if (segment === "\r" || segment === "\n" || segment === "\r\n") return keyInput("enter");
	if (segment === "\t") return keyInput("tab");
	if (segment === "\x7f" || segment === "\b") return keyInput("backspace");
	if (segment === "\x1b") return keyInput("escape");
	if (segment.length === 1) {
		const code = segment.charCodeAt(0);
		if (code >= 1 && code <= 26) {
			return keyInput(String.fromCharCode(96 + code) as LogicalKey, undefined, {
				...NO_MODIFIERS,
				control: true,
			});
		}
		if (segment === " ") return keyInput("space", " ");
		if (/^[a-z]$/.test(segment)) return keyInput(segment as LogicalKey, segment);
		if (/^[A-Z]$/.test(segment)) {
			return keyInput(segment.toLowerCase() as LogicalKey, segment, { ...NO_MODIFIERS, shift: true });
		}
		if (/^[0-9]$/.test(segment)) return keyInput(segment as LogicalKey, segment);
		const punctuation = PUNCTUATION.get(segment);
		if (punctuation) {
			return keyInput(punctuation.key, segment, { ...NO_MODIFIERS, shift: punctuation.shift });
		}
	}
	return undefined;
}

function parseXtermModifiedKey(sequence: string): TerminalInput | undefined {
	if (!sequence.startsWith("\x1b[")) return undefined;
	const match = /^27;(\d+);(\d+)~$/.exec(sequence.slice(2));
	if (!match) return undefined;
	const modifier = Number.parseInt(match[1]!, 10);
	const codePoint = Number.parseInt(match[2]!, 10);
	if (!Number.isSafeInteger(modifier) || modifier < 1 || modifier > 16 || !Number.isSafeInteger(codePoint)) {
		return undefined;
	}
	return inputFromCodePoint(codePoint, decodeModifiers(modifier));
}

function inputFromCodePoint(codePoint: number, modifiers: Modifiers): TerminalInput | undefined {
	if (codePoint < 1 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return undefined;
	const segment = String.fromCodePoint(codePoint);
	const plain = keyFromPlainSegment(segment);
	if (!plain) {
		if (modifiers.control || modifiers.alt || modifiers.meta) return undefined;
		return Object.freeze({ type: "text", text: segment });
	}
	const resolvedModifiers = {
		shift: plain.shift || modifiers.shift,
		control: plain.control || modifiers.control,
		alt: plain.alt || modifiers.alt,
		meta: plain.meta || modifiers.meta,
	};
	const insertable = !resolvedModifiers.control && !resolvedModifiers.alt && !resolvedModifiers.meta;
	const text =
		insertable && plain.text !== undefined
			? resolvedModifiers.shift && /^[a-z]$/.test(plain.text)
				? plain.text.toUpperCase()
				: plain.text
			: undefined;
	return keyInput(plain.key, text, resolvedModifiers);
}

function parseKittyKey(sequence: string): KeyInput | undefined {
	if (!sequence.startsWith("\x1b[") || !sequence.endsWith("u")) return undefined;
	const fields = sequence.slice(2, -1).split(";");
	if (fields.length > 3 || fields.some((field) => !/^[\d:]*$/.test(field))) return undefined;
	const keyCodes = fields[0]?.split(":") ?? [];
	const codePoint = Number.parseInt(keyCodes[0] ?? "", 10);
	if (!Number.isSafeInteger(codePoint)) return undefined;
	const modifierAndEvent = fields[1]?.split(":") ?? [];
	const modifiers = decodeModifiers(Number.parseInt(modifierAndEvent[0] || "1", 10));
	const event = Number.parseInt(modifierAndEvent[1] || "1", 10);
	const action: KeyAction = event === 2 ? "repeat" : event === 3 ? "release" : "press";
	const functional = KITTY_FUNCTIONAL_KEYS.get(codePoint);
	if (functional) return keyInput(functional, undefined, modifiers, action);
	if (codePoint === 27) return keyInput("escape", undefined, modifiers, action);
	if (codePoint === 13) return keyInput("enter", undefined, modifiers, action);
	if (codePoint === 9) return keyInput("tab", undefined, modifiers, action);
	if (codePoint === 127) return keyInput("backspace", undefined, modifiers, action);
	if (codePoint < 0 || codePoint > 0x10ffff) return undefined;
	const plain = keyFromPlainSegment(String.fromCodePoint(codePoint));
	if (!plain) return undefined;
	const resolvedModifiers = {
		shift: plain.shift || modifiers.shift,
		control: modifiers.control,
		alt: modifiers.alt,
		meta: modifiers.meta,
	};
	const insertable =
		action !== "release" && !resolvedModifiers.control && !resolvedModifiers.alt && !resolvedModifiers.meta;
	let text: string | undefined;
	if (insertable) {
		text = decodeKittyText(fields[2]);
		if (text === undefined && plain.text !== undefined) {
			text = resolvedModifiers.shift && /^[a-z]$/.test(plain.text) ? plain.text.toUpperCase() : plain.text;
		}
	}
	return keyInput(plain.key, text, resolvedModifiers, action);
}

function parseSgrMouse(sequence: string): MouseInput | undefined {
	if (!sequence.startsWith("\x1b[")) return undefined;
	const match = /^<(\d+);(\d+);(\d+)([Mm])$/.exec(sequence.slice(2));
	if (!match) return undefined;
	const encoded = Number.parseInt(match[1]!, 10);
	const column = Number.parseInt(match[2]!, 10) - 1;
	const row = Number.parseInt(match[3]!, 10) - 1;
	if (![encoded, column, row].every(Number.isSafeInteger) || column < 0 || row < 0) return undefined;
	const baseButton = encoded & 3;
	const wheel = (encoded & 64) !== 0;
	const motion = (encoded & 32) !== 0;
	const button = wheel
		? baseButton === 0
			? "wheel-up"
			: "wheel-down"
		: baseButton === 0
			? "left"
			: baseButton === 1
				? "middle"
				: baseButton === 2
					? "right"
					: "none";
	return Object.freeze({
		type: "mouse",
		action: motion ? "move" : match[4] === "m" ? "release" : "press",
		button,
		column,
		row,
		shift: (encoded & 4) !== 0,
		alt: (encoded & 8) !== 0,
		control: (encoded & 16) !== 0,
	});
}

function decodeKittyText(field: string | undefined): string | undefined {
	if (!field) return undefined;
	const codePoints = field.split(":").map((value) => Number.parseInt(value, 10));
	if (codePoints.some((value) => !Number.isSafeInteger(value) || value < 1 || value > 0x10ffff)) return undefined;
	return String.fromCodePoint(...codePoints);
}

function decodeModifiers(encoded: number): Modifiers {
	const bits = Math.max(0, encoded - 1);
	return {
		shift: (bits & 1) !== 0,
		alt: (bits & 2) !== 0,
		control: (bits & 4) !== 0,
		meta: (bits & 8) !== 0,
	};
}

function keyInput(
	key: LogicalKey,
	text?: string,
	modifiers: Modifiers = NO_MODIFIERS,
	action: KeyAction = "press",
): KeyInput {
	return Object.freeze({
		type: "key",
		key,
		...(text === undefined ? {} : { text }),
		...modifiers,
		action,
	});
}
