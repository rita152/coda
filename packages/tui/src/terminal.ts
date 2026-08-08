import type { TerminalInput } from "./input.ts";

export type ColorLevel = 0 | 1 | 2 | 3;
export type KeyboardProtocol = "kitty" | "legacy";

export interface TerminalSize {
	readonly columns: number;
	readonly rows: number;
}

export interface TerminalCapabilities {
	readonly keyboardProtocol: KeyboardProtocol;
	readonly colorLevel: ColorLevel;
	readonly synchronizedOutput: boolean;
	readonly keyRelease: boolean;
	readonly sizeFallback: boolean;
}

export type TerminalInputListener = (input: TerminalInput) => void | Promise<void>;

export interface Terminal {
	readonly started: boolean;
	readonly size: TerminalSize;
	readonly capabilities: TerminalCapabilities;

	/** Returns false when the adapter cannot start, such as on non-TTY streams. */
	start(): Promise<boolean>;
	stop(): Promise<void>;
	write(data: string): void;
	flush(): Promise<void>;
	onInput(listener: TerminalInputListener): () => void;
}

export function terminalSize(columns: number, rows: number): TerminalSize {
	return Object.freeze({ columns, rows });
}

export function terminalCapabilities(capabilities: TerminalCapabilities): TerminalCapabilities {
	return Object.freeze({ ...capabilities });
}
