import type { Component, ComponentInputContext } from "./component.ts";
import type { KeyAction, KeyInput, LogicalKey } from "./input.ts";

export interface KeybindingPattern {
	readonly key: LogicalKey;
	readonly shift?: boolean;
	readonly control?: boolean;
	readonly alt?: boolean;
	readonly meta?: boolean;
	readonly action?: KeyAction;
}

export interface KeybindingContext extends ComponentInputContext {
	readonly focused: Component | null;
	focus(component: Component | null): void;
}

export interface Keybinding {
	readonly pattern: KeybindingPattern;
	handle(input: KeyInput, context: KeybindingContext): boolean | Promise<boolean>;
}

export function matchesKeybinding(input: KeyInput, pattern: KeybindingPattern): boolean {
	return (
		input.key === pattern.key &&
		input.shift === (pattern.shift ?? false) &&
		input.control === (pattern.control ?? false) &&
		input.alt === (pattern.alt ?? false) &&
		input.meta === (pattern.meta ?? false) &&
		input.action === (pattern.action ?? "press")
	);
}
