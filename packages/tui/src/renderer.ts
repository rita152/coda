import { displayWidth } from "./ansi.ts";
import type { Terminal } from "./terminal.ts";

export interface RendererErrorDetails {
	readonly actualWidth: number;
	readonly availableWidth: number;
	readonly row: number;
}

export class RendererError extends Error {
	readonly code = "renderer.over-width";
	readonly details: RendererErrorDetails;

	constructor(details: RendererErrorDetails) {
		super(
			`Rendered row ${details.row} is ${details.actualWidth} cells wide; only ${details.availableWidth} are available`,
		);
		this.name = "RendererError";
		this.details = Object.freeze({ ...details });
	}
}

export interface RendererInvariantErrorDetails {
	readonly row: number;
	readonly reason: "embedded-newline";
}

export class RendererInvariantError extends Error {
	readonly code = "renderer.invalid-line";
	readonly details: RendererInvariantErrorDetails;

	constructor(details: RendererInvariantErrorDetails) {
		super(`Rendered row ${details.row} contains an embedded newline`);
		this.name = "RendererInvariantError";
		this.details = Object.freeze({ ...details });
	}
}

export class MainScreenRenderer {
	readonly #terminal: Terminal;
	#previous: readonly string[] = [];

	constructor(terminal: Terminal) {
		this.#terminal = terminal;
	}

	reset(): void {
		this.#previous = [];
	}

	async render(lines: readonly string[]): Promise<void> {
		const { columns, rows } = this.#terminal.size;
		const screen = lines.slice(0, rows);
		for (const [row, line] of screen.entries()) {
			if (line.includes("\n") || line.includes("\r")) {
				throw new RendererInvariantError({ row, reason: "embedded-newline" });
			}
			const actualWidth = displayWidth(line);
			if (actualWidth > columns) {
				throw new RendererError({ actualWidth, availableWidth: columns, row });
			}
		}

		let body = "";
		const comparedRows = Math.min(rows, Math.max(this.#previous.length, screen.length));
		for (let row = 0; row < comparedRows; row++) {
			const next = screen[row] ?? "";
			if (this.#previous[row] === next) continue;
			body += `\x1b[${row + 1};1H\x1b[2K${next}`;
		}

		if (body) {
			body += "\x1b[H";
			const output = this.#terminal.capabilities.synchronizedOutput ? `\x1b[?2026h${body}\x1b[?2026l` : body;
			this.#terminal.write(output);
			await this.#terminal.flush();
		}
		this.#previous = Object.freeze([...screen]);
	}
}
