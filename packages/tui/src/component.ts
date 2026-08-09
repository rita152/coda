import type { TerminalInput } from "./input.ts";
import type { ImagePlacement } from "./terminal-image-surface.ts";

export interface ComponentOptions {
	readonly focusable?: boolean;
}

export interface RenderContext {
	readonly width: number;
	readonly height: number;
	readonly now: number;
}

export interface CursorPlacement {
	readonly row: number;
	readonly column: number;
	readonly visible: boolean;
}

export interface ComponentInputContext {
	requestImmediateRender(): void;
}

export type ComponentInputResult = void | Promise<void>;

const invalidationListeners = new WeakMap<Component, Set<() => void>>();
const focusStates = new WeakMap<Component, boolean>();

export abstract class Component {
	readonly focusable: boolean;

	constructor(options: ComponentOptions = {}) {
		this.focusable = options.focusable ?? false;
		focusStates.set(this, false);
	}

	get focused(): boolean {
		return focusStates.get(this) ?? false;
	}

	abstract render(context: RenderContext): string[];

	animationInterval(_context: RenderContext): number | undefined {
		return undefined;
	}

	imagePlacements(_context: RenderContext): readonly ImagePlacement[] {
		return [];
	}

	cursorPlacement(_context: RenderContext): CursorPlacement | undefined {
		return undefined;
	}

	handleInput?(_input: TerminalInput, _context: ComponentInputContext): ComponentInputResult;

	invalidate(): void {
		const listeners = invalidationListeners.get(this);
		if (!listeners) return;
		for (const listener of [...listeners]) listener();
	}
}

export function setComponentFocused(component: Component, focused: boolean): void {
	if (component.focused === focused) return;
	focusStates.set(component, focused);
	component.invalidate();
}

export function observeInvalidation(component: Component, listener: () => void): () => void {
	let listeners = invalidationListeners.get(component);
	if (!listeners) {
		listeners = new Set();
		invalidationListeners.set(component, listeners);
	}
	listeners.add(listener);
	return () => {
		listeners?.delete(listener);
		if (listeners?.size === 0) invalidationListeners.delete(component);
	};
}
