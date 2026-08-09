import { clipAnsi, displayWidth, sanitizeTerminalText, sliceAnsi } from "./ansi.ts";
import {
	Component,
	type CursorPlacement,
	observeInvalidation,
	type RenderContext,
	setComponentFocused,
} from "./component.ts";
import type { Diagnostic, DiagnosticSink } from "./diagnostics.ts";
import type { TerminalInput } from "./input.ts";
import { type Keybinding, type KeybindingContext, matchesKeybinding } from "./keybindings.ts";
import { FullScreenRenderer, RendererError, RendererInvariantError } from "./renderer.ts";
import type { Clock, ScheduledTask, Scheduler } from "./runtime.ts";
import type { Terminal, TerminalSize } from "./terminal.ts";
import type { ImagePlacement, TerminalImageSurface } from "./terminal-image-surface.ts";

const FRAME_INTERVAL_MS = 1000 / 60;
const STYLE_BOUNDARY = "\x1b[0m";
const DIAGNOSTIC_BATCH_MS = 150;
const DIAGNOSTIC_UPDATE_MS = 1_000;
const DIAGNOSTIC_VISIBLE_MS = 4_000;
const DIAGNOSTIC_CAPACITY = 64;

export interface OverlayPlacement {
	readonly row?: number;
	readonly column?: number;
	readonly width?: number;
	readonly height?: number;
}

export type OverlayLayout = (viewport: TerminalSize) => OverlayPlacement;

export interface OverlayOptions extends OverlayPlacement {
	readonly focus?: boolean;
	readonly layout?: OverlayLayout;
}

export interface OverlayHandle {
	readonly visible: boolean;
	readonly removed: boolean;
	show(): void;
	hide(): void;
	focus(): void;
	remove(): void;
}

type FocusErrorCode = "focus.not-focusable" | "focus.not-mounted" | "focus.not-visible";

export class FocusError extends Error {
	readonly code: FocusErrorCode;

	constructor(code: FocusErrorCode, message: string) {
		super(message);
		this.name = "FocusError";
		this.code = code;
	}
}

interface OverlayEntry {
	readonly component: Component;
	readonly row: number;
	readonly column: number;
	readonly width?: number;
	readonly height?: number;
	readonly layout?: OverlayLayout;
	visible: boolean;
	removed: boolean;
	previousFocus: Component | null;
}

interface ResolvedOverlayPlacement extends OverlayPlacement {
	readonly row: number;
	readonly column: number;
}

export interface TuiOptions {
	readonly terminal: Terminal;
	readonly root: Component;
	readonly clock: Clock;
	readonly scheduler: Scheduler;
	readonly keybindings: readonly Keybinding[];
	readonly diagnostics?: DiagnosticSink;
	readonly imageSurface?: TerminalImageSurface;
}

export class Tui {
	readonly #terminal: Terminal;
	readonly #root: Component;
	readonly #clock: Clock;
	readonly #scheduler: Scheduler;
	readonly #keybindings: readonly Keybinding[];
	readonly #diagnostics?: DiagnosticSink;
	readonly #imageSurface?: TerminalImageSurface;
	readonly #renderer: FullScreenRenderer;
	readonly #mounted = new Set<Component>();
	readonly #invalidationSubscriptions = new Map<Component, () => void>();
	readonly #overlays: OverlayEntry[] = [];
	#focused: Component | null = null;
	#started = false;
	#startPromise?: Promise<boolean>;
	#stopPromise?: Promise<void>;
	#unsubscribeInput?: () => void;
	#scheduled?: ScheduledTask;
	#animationTask?: ScheduledTask;
	#scheduledRun?: Promise<void>;
	#renderPromise?: Promise<void>;
	#dirty = true;
	#renderAgain = false;
	#lastRenderAt = Number.NEGATIVE_INFINITY;
	#lastRenderError?: unknown;

	constructor(options: TuiOptions) {
		this.#terminal = options.terminal;
		this.#root = options.root;
		this.#clock = options.clock;
		this.#scheduler = options.scheduler;
		this.#keybindings = Object.freeze([...options.keybindings]);
		this.#diagnostics = options.diagnostics;
		this.#imageSurface = options.imageSurface;
		this.#renderer = new FullScreenRenderer(options.terminal);
	}

	get started(): boolean {
		return this.#started;
	}

	get focused(): Component | null {
		return this.#focused;
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
		if (!this.#terminal.available) return false;
		let failed = false;
		let failure: unknown;
		try {
			await this.#renderer.enter();
			const available = await this.#terminal.start();
			if (available) {
				this.#unsubscribeInput = this.#terminal.onInput((input) => this.#handleInput(input));

				this.#started = true;
				this.#dirty = true;
				this.#mount(this.#root);
				for (const overlay of this.#overlays) {
					if (!overlay.removed) this.#mount(overlay.component);
				}
				if (this.#root.focusable) this.focus(this.#root);
				await this.renderNow();
				return true;
			}
		} catch (error) {
			failed = true;
			failure = error;
		}

		try {
			await this.#cleanupAfterFailedStart();
		} catch (cleanupError) {
			if (failed) throw new AggregateError([failure, cleanupError], "TUI start and cleanup both failed");
			throw cleanupError;
		}
		if (failed) throw failure;
		return false;
	}

	#mount(component: Component): void {
		if (this.#mounted.has(component)) return;
		this.#mounted.add(component);
		this.#invalidationSubscriptions.set(
			component,
			observeInvalidation(component, () => this.requestRender()),
		);
	}

	#unmount(component: Component): void {
		if (!this.#mounted.delete(component)) return;
		this.#invalidationSubscriptions.get(component)?.();
		this.#invalidationSubscriptions.delete(component);
		if (this.#focused === component) {
			setComponentFocused(component, false);
			this.#focused = null;
		}
	}

	#unmountAll(): void {
		for (const component of [...this.#mounted]) this.#unmount(component);
	}

	async #cleanupAfterFailedStart(): Promise<void> {
		const failures: unknown[] = [];
		this.#cancelScheduled();
		this.#cancelAnimation();
		this.#unsubscribeInput?.();
		this.#unsubscribeInput = undefined;
		this.#started = false;
		this.#unmountAll();
		try {
			await this.#imageSurface?.dispose();
		} catch (error) {
			failures.push(error);
		}
		try {
			await this.#renderer.prepareToLeave();
		} catch (error) {
			failures.push(error);
		}
		try {
			await this.#terminal.stop();
		} catch (error) {
			failures.push(error);
		} finally {
			try {
				await this.#renderer.leave();
			} catch (error) {
				failures.push(error);
			}
		}
		if (failures.length === 1) throw failures[0];
		if (failures.length > 1) throw new AggregateError(failures, "Multiple TUI cleanup operations failed");
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
			try {
				await this.#startPromise;
			} catch {
				return;
			}
		}
		if (!this.#started) return;
		await this.#performStop();
	}

	async #performStop(): Promise<void> {
		let failure: unknown;
		try {
			await this.flush();
		} catch (error) {
			failure = error;
		} finally {
			this.#cancelScheduled();
			this.#cancelAnimation();
			this.#unsubscribeInput?.();
			this.#unsubscribeInput = undefined;
			this.#started = false;
			this.#unmountAll();
			try {
				await this.#imageSurface?.dispose();
			} catch (error) {
				failure ??= error;
			}
			try {
				await this.#renderer.prepareToLeave();
			} catch (error) {
				failure ??= error;
			}
			try {
				await this.#terminal.stop();
			} catch (error) {
				failure ??= error;
			} finally {
				try {
					await this.#renderer.leave();
				} catch (error) {
					failure ??= error;
				}
			}
		}
		if (failure !== undefined) throw failure;
	}

	focus(component: Component | null): void {
		if (component === this.#focused) return;
		if (component !== null) {
			if (!this.#mounted.has(component)) {
				throw new FocusError("focus.not-mounted", "Focus target is not mounted in this TUI");
			}
			if (!component.focusable) {
				throw new FocusError("focus.not-focusable", "Focus target is not focusable");
			}
			const overlay = this.#overlays.find((entry) => entry.component === component && !entry.removed);
			if (overlay && !overlay.visible) {
				throw new FocusError("focus.not-visible", "Focus target belongs to a hidden overlay");
			}
		}

		if (this.#focused) setComponentFocused(this.#focused, false);
		this.#focused = component;
		if (component) setComponentFocused(component, true);
	}

	showOverlay(component: Component, options: OverlayOptions = {}): OverlayHandle {
		if (component === this.#root || this.#overlays.some((entry) => entry.component === component && !entry.removed)) {
			throw new Error("Component is already mounted in this TUI");
		}
		if (
			options.layout &&
			[options.row, options.column, options.width, options.height].some((value) => value !== undefined)
		) {
			throw new Error("Overlay layout cannot be combined with fixed placement");
		}
		const placement = validateOverlayPlacement(options);

		const entry: OverlayEntry = {
			component,
			...placement,
			layout: options.layout,
			visible: true,
			removed: false,
			previousFocus: null,
		};
		this.#overlays.push(entry);
		if (this.#started) this.#mount(component);
		this.requestRender();
		if (options.focus) this.#focusOverlay(entry);

		const assertActive = (): void => {
			if (entry.removed) throw new Error("Overlay handle has been removed");
		};
		return {
			get visible() {
				return entry.visible && !entry.removed;
			},
			get removed() {
				return entry.removed;
			},
			show: () => {
				assertActive();
				if (entry.visible) return;
				entry.visible = true;
				this.requestRender();
			},
			hide: () => {
				assertActive();
				if (!entry.visible) return;
				entry.visible = false;
				if (this.#focused === component) this.#restoreOverlayFocus(entry);
				this.requestRender();
			},
			focus: () => {
				assertActive();
				this.#focusOverlay(entry);
			},
			remove: () => {
				if (entry.removed) return;
				entry.visible = false;
				entry.removed = true;
				if (this.#focused === component) this.#restoreOverlayFocus(entry);
				this.#unmount(component);
				this.requestRender();
			},
		};
	}

	#focusOverlay(entry: OverlayEntry): void {
		if (!entry.visible) {
			throw new FocusError("focus.not-visible", "Cannot focus a hidden overlay");
		}
		if (this.#focused !== entry.component) entry.previousFocus = this.#focused;
		this.focus(entry.component);
	}

	#restoreOverlayFocus(entry: OverlayEntry): void {
		const previous = entry.previousFocus;
		if (previous && this.#canFocus(previous)) this.focus(previous);
		else if (this.#canFocus(this.#root)) this.focus(this.#root);
		else this.focus(null);
	}

	#canFocus(component: Component): boolean {
		if (!this.#mounted.has(component) || !component.focusable) return false;
		const overlay = this.#overlays.find((entry) => entry.component === component && !entry.removed);
		return !overlay || overlay.visible;
	}

	requestRender(): void {
		if (!this.#started) return;
		this.#dirty = true;
		if (this.#renderPromise) {
			this.#renderAgain = true;
			return;
		}
		if (this.#scheduled) return;
		const elapsed = this.#clock.now() - this.#lastRenderAt;
		const delayMs = Math.max(0, FRAME_INTERVAL_MS - elapsed);
		this.#scheduled = this.#scheduler.schedule(delayMs, () => this.#runScheduledFrame());
	}

	async #runScheduledFrame(): Promise<void> {
		this.#scheduled = undefined;
		const run = this.renderNow().catch((error: unknown) => {
			this.#lastRenderError = error;
		});
		this.#scheduledRun = run;
		try {
			await run;
		} finally {
			if (this.#scheduledRun === run) this.#scheduledRun = undefined;
		}
	}

	async renderNow(): Promise<void> {
		if (!this.#started) return;
		this.#cancelScheduled();
		this.#dirty = true;
		if (this.#renderPromise) {
			this.#renderAgain = true;
			return this.#renderPromise;
		}

		const render = Promise.resolve().then(() => this.#renderLoop());
		this.#renderPromise = render;
		try {
			await render;
			this.#lastRenderError = undefined;
		} catch (error) {
			this.#lastRenderError = error;
			await this.#report(error);
			throw error;
		} finally {
			if (this.#renderPromise === render) this.#renderPromise = undefined;
		}
	}

	async #renderLoop(): Promise<void> {
		do {
			this.#dirty = false;
			this.#renderAgain = false;
			const frame = this.#renderComponents();
			await this.#renderer.render(frame.lines, frame.cursor);
			await this.#imageSurface?.reconcile(frame.images);
			this.#lastRenderAt = this.#clock.now();
			this.#scheduleAnimation();
		} while (this.#renderAgain || this.#dirty);
	}

	#renderComponents(): {
		readonly lines: string[];
		readonly images: readonly ImagePlacement[];
		readonly cursor?: CursorPlacement;
	} {
		const { columns: terminalWidth, rows: terminalHeight } = this.#terminal.size;
		const context: RenderContext = Object.freeze({
			width: terminalWidth,
			height: terminalHeight,
			now: this.#clock.now(),
		});
		const lines = [...this.#root.render(context)];
		const images: ImagePlacement[] = [...this.#root.imagePlacements(context)];
		let cursor = this.#root.cursorPlacement(context);
		for (const overlay of this.#overlays) {
			if (!overlay.visible || overlay.removed) continue;
			const dynamic = overlay.layout?.(Object.freeze({ columns: terminalWidth, rows: terminalHeight }));
			const placement = dynamic ? validateOverlayPlacement(dynamic) : overlay;
			const row = placement.row ?? 0;
			const column = placement.column ?? 0;
			const width = placement.width ?? terminalWidth - column;
			const height = placement.height ?? terminalHeight - row;
			if (width < 1 || column + width > terminalWidth) {
				throw new RangeError("Overlay placement exceeds the terminal width");
			}
			if (height < 1 || row + height > terminalHeight) {
				throw new RangeError("Overlay placement exceeds the terminal height");
			}
			const overlayContext = Object.freeze({
				width,
				height,
				now: context.now,
			});
			const overlayLines = overlay.component.render(overlayContext);
			if (overlayLines.length > height) throw new RangeError("Overlay content exceeds its placement height");
			const overlayCursor = overlay.component.cursorPlacement(overlayContext);
			if (overlayCursor) {
				cursor = {
					row: overlayCursor.row + row,
					column: overlayCursor.column + column,
					visible: overlayCursor.visible,
				};
			}
			images.push(
				...overlay.component.imagePlacements(overlayContext).map((placement) => ({
					...placement,
					row: placement.row + row,
					column: placement.column + column,
				})),
			);
			for (const [lineOffset, overlayLine] of overlayLines.entries()) {
				const outputRow = row + lineOffset;
				const actualWidth = displayWidth(overlayLine);
				if (actualWidth > width) {
					throw new RendererError({ actualWidth, availableWidth: width, row: outputRow });
				}
				while (lines.length <= outputRow) lines.push("");
				const base = lines[outputRow] ?? "";
				lines[outputRow] = compositeLine(base, overlayLine, column, width, terminalWidth);
			}
		}
		return { lines, images: Object.freeze(images), cursor };
	}

	async flush(): Promise<void> {
		if (this.#scheduled) {
			this.#cancelScheduled();
			await this.renderNow();
		}
		await this.#scheduledRun;
		await this.#renderPromise;
		if (this.#dirty && this.#started) await this.renderNow();
		await this.#terminal.flush();
		if (this.#lastRenderError !== undefined) throw this.#lastRenderError;
	}

	#cancelScheduled(): void {
		this.#scheduled?.cancel();
		this.#scheduled = undefined;
	}

	#scheduleAnimation(): void {
		this.#cancelAnimation();
		if (!this.#started) return;
		const { columns: width, rows: height } = this.#terminal.size;
		const context: RenderContext = Object.freeze({ width, height, now: this.#clock.now() });
		let interval: number | undefined;
		const visible = [
			this.#root,
			...this.#overlays.filter((entry) => entry.visible && !entry.removed).map((entry) => entry.component),
		];
		for (const component of visible) {
			const candidate = component.animationInterval(context);
			if (candidate === undefined) continue;
			if (!Number.isFinite(candidate) || candidate < FRAME_INTERVAL_MS) {
				throw new RangeError(`Animation interval must be at least ${FRAME_INTERVAL_MS}ms`);
			}
			interval = interval === undefined ? candidate : Math.min(interval, candidate);
		}
		if (interval === undefined) return;
		this.#animationTask = this.#scheduler.schedule(interval, async () => {
			this.#animationTask = undefined;
			await this.renderNow();
		});
	}

	#cancelAnimation(): void {
		this.#animationTask?.cancel();
		this.#animationTask = undefined;
	}

	async #handleInput(input: TerminalInput): Promise<void> {
		if (input.type === "resize") {
			await this.renderNow();
			return;
		}

		let immediate = false;
		const thisTui = this;
		const context: KeybindingContext = {
			get focused() {
				return thisTui.#focused;
			},
			focus: (component) => this.focus(component),
			requestImmediateRender: () => {
				immediate = true;
			},
		};
		let consumed = false;
		if (input.type === "key") {
			for (const binding of this.#keybindings) {
				if (!matchesKeybinding(input, binding.pattern)) continue;
				if (await binding.handle(input, context)) {
					consumed = true;
					break;
				}
			}
		}
		if (!consumed) await this.#focused?.handleInput?.(input, context);
		if (immediate) await this.renderNow();
	}

	async #report(error: unknown): Promise<void> {
		if (!this.#diagnostics) return;
		let diagnostic: Diagnostic;
		if (error instanceof RendererError || error instanceof RendererInvariantError) {
			diagnostic = { code: error.code, message: error.message, details: { ...error.details } };
		} else {
			diagnostic = { code: "renderer.failure", message: error instanceof Error ? error.message : String(error) };
		}
		try {
			await this.#diagnostics(diagnostic);
		} catch {
			// The original rendering failure remains authoritative.
		}
	}
}

class DiagnosticOverlay extends Component {
	#message = "";

	render(context: RenderContext): string[] {
		return this.#message ? [clipAnsi(this.#message, context.width)] : [];
	}

	setMessage(message: string): void {
		if (message === this.#message) return;
		this.#message = message;
		this.invalidate();
	}
}

interface BufferedDiagnostic {
	readonly diagnostic: Diagnostic;
	readonly identity: string;
	repeats: number;
}

/** The only interactive TUI mode. Named explicitly at the public seam. */
export class FullScreenTui extends Tui {
	readonly #diagnosticOverlay: DiagnosticOverlay;
	readonly #diagnosticHandle: OverlayHandle;
	readonly #clock: Clock;
	readonly #scheduler: Scheduler;
	readonly #diagnostics: BufferedDiagnostic[] = [];
	#pendingDiagnostic?: BufferedDiagnostic;
	#batchTask?: ScheduledTask;
	#hideTask?: ScheduledTask;
	#lastPresentationAt = Number.NEGATIVE_INFINITY;
	#droppedDiagnostics = 0;

	constructor(options: TuiOptions) {
		super(options);
		this.#clock = options.clock;
		this.#scheduler = options.scheduler;
		this.#diagnosticOverlay = new DiagnosticOverlay();
		this.#diagnosticHandle = this.showOverlay(this.#diagnosticOverlay, {
			layout: ({ columns, rows }) => ({ row: rows - 1, column: 0, width: columns, height: 1 }),
		});
		this.#diagnosticHandle.hide();
	}

	presentDiagnostic(diagnostic: Diagnostic): void {
		const snapshot = Object.freeze({
			...diagnostic,
			...(diagnostic.details === undefined ? {} : { details: Object.freeze({ ...diagnostic.details }) }),
		});
		const identity = diagnosticIdentity(snapshot);
		const previous = this.#diagnostics.at(-1);
		let buffered: BufferedDiagnostic;
		if (previous?.identity === identity) {
			previous.repeats++;
			buffered = previous;
		} else {
			buffered = { diagnostic: snapshot, identity, repeats: 1 };
			this.#diagnostics.push(buffered);
			if (this.#diagnostics.length > DIAGNOSTIC_CAPACITY) {
				this.#diagnostics.shift();
				this.#droppedDiagnostics++;
			}
		}
		this.#pendingDiagnostic = buffered;
		if (this.#batchTask) return;
		const delayMs = Math.max(
			DIAGNOSTIC_BATCH_MS,
			this.#lastPresentationAt + DIAGNOSTIC_UPDATE_MS - this.#clock.now(),
		);
		this.#batchTask = this.#scheduler.schedule(delayMs, () => {
			this.#batchTask = undefined;
			const pending = this.#pendingDiagnostic;
			this.#pendingDiagnostic = undefined;
			if (!pending) return;
			this.#lastPresentationAt = this.#clock.now();
			this.#diagnosticOverlay.setMessage(
				formatDiagnostic(pending.diagnostic, pending.repeats, this.#droppedDiagnostics),
			);
			this.#diagnosticHandle.show();
			this.#hideTask?.cancel();
			this.#hideTask = this.#scheduler.schedule(DIAGNOSTIC_VISIBLE_MS, () => {
				this.#hideTask = undefined;
				this.#diagnosticHandle.hide();
			});
		});
	}

	override async stop(): Promise<void> {
		try {
			await super.stop();
		} finally {
			this.#batchTask?.cancel();
			this.#batchTask = undefined;
			this.#hideTask?.cancel();
			this.#hideTask = undefined;
			this.#pendingDiagnostic = undefined;
			this.#diagnostics.length = 0;
			this.#droppedDiagnostics = 0;
			this.#lastPresentationAt = Number.NEGATIVE_INFINITY;
			this.#diagnosticOverlay.setMessage("");
			this.#diagnosticHandle.hide();
		}
	}
}

function formatDiagnostic(diagnostic: Diagnostic, repeats: number, dropped: number): string {
	const details = Object.entries(diagnostic.details ?? {})
		.map(([name, value]) => `${name}=${jsonDiagnosticValue(value)}`)
		.join(" ");
	return sanitizeTerminalText(
		`[${diagnostic.code}]${details ? ` ${details} ·` : ""} ${diagnostic.message}${repeats > 1 ? ` ×${repeats}` : ""}${dropped > 0 ? ` · ${dropped} older dropped` : ""}`,
	).replace(/[\r\n]+/g, " ");
}

function diagnosticIdentity(diagnostic: Diagnostic): string {
	return `${diagnostic.code}\0${diagnostic.message}\0${jsonDiagnosticValue(diagnostic.details ?? {})}`;
}

function jsonDiagnosticValue(value: unknown): string {
	let serialized: string | undefined;
	try {
		serialized = JSON.stringify(value);
	} catch {
		// Fall through to a quoted string representation.
	}
	if (serialized === undefined) {
		try {
			serialized = JSON.stringify(String(value));
		} catch {
			serialized = '"[unserializable]"';
		}
	}
	let escaped = "";
	for (const character of serialized) {
		const codePoint = character.codePointAt(0)!;
		escaped += codePoint >= 0x7f && codePoint <= 0x9f ? `\\u${codePoint.toString(16).padStart(4, "0")}` : character;
	}
	return escaped;
}

function validateOverlayPlacement(placement: OverlayPlacement): ResolvedOverlayPlacement {
	const row = placement.row ?? 0;
	const column = placement.column ?? 0;
	if (!Number.isSafeInteger(row) || row < 0 || !Number.isSafeInteger(column) || column < 0) {
		throw new RangeError("Overlay row and column must be non-negative integers");
	}
	for (const [name, value] of [
		["width", placement.width],
		["height", placement.height],
	] as const) {
		if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
			throw new RangeError(`Overlay ${name} must be a positive integer`);
		}
	}
	return {
		row,
		column,
		...(placement.width === undefined ? {} : { width: placement.width }),
		...(placement.height === undefined ? {} : { height: placement.height }),
	};
}

function compositeLine(base: string, overlay: string, column: number, width: number, totalWidth: number): string {
	const before = sliceAnsi(base, 0, column);
	const beforePadding = " ".repeat(Math.max(0, column - displayWidth(before)));
	const overlayPadding = " ".repeat(Math.max(0, width - displayWidth(overlay)));
	const afterColumn = column + width;
	const after = sliceAnsi(base, afterColumn, Math.max(0, totalWidth - afterColumn));
	return `${before}${beforePadding}${STYLE_BOUNDARY}${overlay}${overlayPadding}${STYLE_BOUNDARY}${after}`;
}
