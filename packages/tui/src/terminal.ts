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
	/** Synchronous preflight for whether writing interactive terminal controls is safe. */
	readonly available: boolean;
	readonly started: boolean;
	readonly size: TerminalSize;
	readonly capabilities: TerminalCapabilities;

	/** Returns false when the adapter cannot start, including after a successful preflight. */
	start(): Promise<boolean>;
	stop(): Promise<void>;
	write(data: string): void;
	/** Waits only for terminal writes; safe to call while handling terminal input. */
	flushOutput(): Promise<void>;
	/** Waits for queued input handlers and output writes. */
	flush(): Promise<void>;
	onInput(listener: TerminalInputListener): () => void;
}

export function terminalSize(columns: number, rows: number): TerminalSize {
	return Object.freeze({ columns, rows });
}

export function terminalCapabilities(capabilities: TerminalCapabilities): TerminalCapabilities {
	return Object.freeze({ ...capabilities });
}
