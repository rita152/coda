import { displayWidth, sliceAnsi } from "./ansi.ts";
import { type Component, observeInvalidation, setComponentFocused } from "./component.ts";
import type { Diagnostic, DiagnosticSink } from "./diagnostics.ts";
import type { TerminalInput } from "./input.ts";
import { type Keybinding, type KeybindingContext, matchesKeybinding } from "./keybindings.ts";
import { MainScreenRenderer, RendererError, RendererInvariantError } from "./renderer.ts";
import type { Clock, ScheduledTask, Scheduler } from "./runtime.ts";
import type { Terminal } from "./terminal.ts";

const FRAME_INTERVAL_MS = 1000 / 60;
const STYLE_BOUNDARY = "\x1b[0m";

export interface OverlayOptions {
	readonly row?: number;
	readonly column?: number;
	readonly width?: number;
	readonly focus?: boolean;
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
	visible: boolean;
	removed: boolean;
	previousFocus: Component | null;
}

export interface TuiOptions {
	readonly terminal: Terminal;
	readonly root: Component;
	readonly clock: Clock;
	readonly scheduler: Scheduler;
	readonly keybindings: readonly Keybinding[];
	readonly diagnostics?: DiagnosticSink;
}

export class Tui {
	readonly #terminal: Terminal;
	readonly #root: Component;
	readonly #clock: Clock;
	readonly #scheduler: Scheduler;
	readonly #keybindings: readonly Keybinding[];
	readonly #diagnostics?: DiagnosticSink;
	readonly #renderer: MainScreenRenderer;
	readonly #mounted = new Set<Component>();
	readonly #invalidationSubscriptions = new Map<Component, () => void>();
	readonly #overlays: OverlayEntry[] = [];
	#focused: Component | null = null;
	#started = false;
	#startPromise?: Promise<boolean>;
	#stopPromise?: Promise<void>;
	#unsubscribeInput?: () => void;
	#scheduled?: ScheduledTask;
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
		this.#renderer = new MainScreenRenderer(options.terminal);
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
		this.#unsubscribeInput = this.#terminal.onInput((input) => this.#handleInput(input));
		try {
			const available = await this.#terminal.start();
			if (!available) {
				this.#unsubscribeInput();
				this.#unsubscribeInput = undefined;
				return false;
			}

			this.#started = true;
			this.#dirty = true;
			this.#mount(this.#root);
			for (const overlay of this.#overlays) {
				if (!overlay.removed) this.#mount(overlay.component);
			}
			if (this.#root.focusable) this.focus(this.#root);
			await this.renderNow();
			return true;
		} catch (error) {
			try {
				await this.#cleanupAfterFailedStart();
			} catch (cleanupError) {
				throw new AggregateError([error, cleanupError], "TUI start and cleanup both failed");
			}
			throw error;
		}
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
		this.#cancelScheduled();
		this.#unsubscribeInput?.();
		this.#unsubscribeInput = undefined;
		this.#started = false;
		this.#unmountAll();
		this.#renderer.reset();
		await this.#terminal.stop();
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
			this.#unsubscribeInput?.();
			this.#unsubscribeInput = undefined;
			this.#started = false;
			this.#unmountAll();
			this.#renderer.reset();
			try {
				await this.#terminal.stop();
			} catch (error) {
				failure ??= error;
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
		const row = options.row ?? 0;
		const column = options.column ?? 0;
		if (!Number.isSafeInteger(row) || row < 0 || !Number.isSafeInteger(column) || column < 0) {
			throw new RangeError("Overlay row and column must be non-negative integers");
		}
		if (options.width !== undefined && (!Number.isSafeInteger(options.width) || options.width < 1)) {
			throw new RangeError("Overlay width must be a positive integer");
		}

		const entry: OverlayEntry = {
			component,
			row,
			column,
			width: options.width,
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
			await this.#renderer.render(this.#renderComponents());
			this.#lastRenderAt = this.#clock.now();
		} while (this.#renderAgain || this.#dirty);
	}

	#renderComponents(): string[] {
		const terminalWidth = this.#terminal.size.columns;
		const lines = [...this.#root.render(terminalWidth)];
		for (const overlay of this.#overlays) {
			if (!overlay.visible || overlay.removed) continue;
			const width = overlay.width ?? terminalWidth - overlay.column;
			if (width < 1 || overlay.column + width > terminalWidth) {
				throw new RangeError("Overlay placement exceeds the terminal width");
			}
			const overlayLines = overlay.component.render(width);
			for (const [lineOffset, overlayLine] of overlayLines.entries()) {
				const row = overlay.row + lineOffset;
				const actualWidth = displayWidth(overlayLine);
				if (actualWidth > width) {
					throw new RendererError({ actualWidth, availableWidth: width, row });
				}
				const base = lines[row] ?? "";
				lines[row] = compositeLine(base, overlayLine, overlay.column, width, terminalWidth);
			}
		}
		return lines;
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

function compositeLine(base: string, overlay: string, column: number, width: number, totalWidth: number): string {
	const before = sliceAnsi(base, 0, column);
	const beforePadding = " ".repeat(Math.max(0, column - displayWidth(before)));
	const overlayPadding = " ".repeat(Math.max(0, width - displayWidth(overlay)));
	const afterColumn = column + width;
	const after = sliceAnsi(base, afterColumn, Math.max(0, totalWidth - afterColumn));
	return `${before}${beforePadding}${STYLE_BOUNDARY}${overlay}${overlayPadding}${STYLE_BOUNDARY}${after}`;
}
