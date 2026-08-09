import type { TerminalInput } from "./input.ts";
import {
	type Terminal,
	type TerminalCapabilities,
	type TerminalInputListener,
	type TerminalSize,
	terminalCapabilities,
	terminalSize,
} from "./terminal.ts";

export interface VirtualTerminalOptions {
	readonly columns?: number;
	readonly rows?: number;
	readonly capabilities?: Partial<TerminalCapabilities>;
}

const DEFAULT_CAPABILITIES: TerminalCapabilities = {
	keyboardProtocol: "kitty",
	colorLevel: 3,
	synchronizedOutput: true,
	keyRelease: true,
	sizeFallback: false,
};

/** Deterministic Terminal implementation intended for tests and embedded renderers. */
export class VirtualTerminal implements Terminal {
	readonly available: boolean = true;
	#started = false;
	#size: TerminalSize;
	#capabilities: TerminalCapabilities;
	readonly #listeners = new Set<TerminalInputListener>();
	readonly #writes: string[] = [];

	constructor(options: VirtualTerminalOptions = {}) {
		this.#size = terminalSize(options.columns ?? 80, options.rows ?? 24);
		this.#capabilities = terminalCapabilities({
			...DEFAULT_CAPABILITIES,
			...options.capabilities,
		});
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
		this.#started = true;
		return true;
	}

	async stop(): Promise<void> {
		this.#started = false;
	}

	write(data: string): void {
		this.#writes.push(data);
	}

	async flush(): Promise<void> {}

	async flushOutput(): Promise<void> {}

	onInput(listener: TerminalInputListener): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	async emit(input: TerminalInput): Promise<void> {
		if (!this.#started) {
			throw new Error("VirtualTerminal must be started before it can emit input");
		}

		const snapshot = Object.freeze({ ...input }) as TerminalInput;
		if (snapshot.type === "resize") {
			this.#size = terminalSize(snapshot.columns, snapshot.rows);
			if (this.#capabilities.sizeFallback) {
				this.#capabilities = terminalCapabilities({ ...this.#capabilities, sizeFallback: false });
			}
		}

		for (const listener of this.#listeners) {
			await listener(snapshot);
		}
	}

	readOutput(): string {
		return this.#writes.join("");
	}

	takeOutput(): string {
		const output = this.readOutput();
		this.#writes.length = 0;
		return output;
	}

	clearOutput(): void {
		this.#writes.length = 0;
	}
}
