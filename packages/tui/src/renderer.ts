import { displayWidth } from "./ansi.ts";
import type { CursorPlacement } from "./component.ts";
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

const ENTER_ALTERNATE_SCREEN = "\x1b[?1049h";
const LEAVE_ALTERNATE_SCREEN = "\x1b[?1049l";
const DISABLE_AUTOWRAP = "\x1b[?7l";
const ENABLE_AUTOWRAP = "\x1b[?7h";
const CLEAR_AND_HOME = "\x1b[2J\x1b[H";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const ENABLE_MOUSE = "\x1b[?1003h\x1b[?1006h";
const DISABLE_MOUSE = "\x1b[?1003l\x1b[?1006l";

export class FullScreenRenderer {
	readonly #terminal: Terminal;
	#previous: readonly string[] = [];
	#previousColumns?: number;
	#previousRows?: number;
	#previousCursor?: string;
	#entered = false;

	constructor(terminal: Terminal) {
		this.#terminal = terminal;
	}

	async enter(): Promise<void> {
		if (this.#entered) return;
		this.reset();
		this.#entered = true;
		this.#terminal.write(
			`${ENTER_ALTERNATE_SCREEN}${DISABLE_AUTOWRAP}${ENABLE_MOUSE}${CLEAR_AND_HOME}${HIDE_CURSOR}`,
		);
		await this.#terminal.flushOutput();
	}

	async prepareToLeave(): Promise<void> {
		if (!this.#entered) return;
		this.#terminal.write(`${DISABLE_MOUSE}${SHOW_CURSOR}${ENABLE_AUTOWRAP}`);
		await this.#terminal.flushOutput();
	}

	async leave(): Promise<void> {
		if (!this.#entered) return;
		this.#terminal.write(`${LEAVE_ALTERNATE_SCREEN}${SHOW_CURSOR}`);
		await this.#terminal.flushOutput();
		this.#entered = false;
		this.reset();
	}

	reset(): void {
		this.#previous = [];
		this.#previousColumns = undefined;
		this.#previousRows = undefined;
		this.#previousCursor = undefined;
	}

	async render(lines: readonly string[], cursor?: CursorPlacement): Promise<void> {
		const { columns, rows } = this.#terminal.size;
		const screen = lines.slice(0, rows);
		validateScreen(screen, columns);
		validateCursor(cursor, columns, rows);

		const dimensionsChanged = this.#previousColumns !== columns || this.#previousRows !== rows;
		let body = dimensionsChanged ? CLEAR_AND_HOME : "";
		const comparedRows = dimensionsChanged ? rows : Math.min(rows, Math.max(this.#previous.length, screen.length));
		for (let row = 0; row < comparedRows; row++) {
			const next = screen[row] ?? "";
			if (!dimensionsChanged && this.#previous[row] === next) continue;
			body += `\x1b[${row + 1};1H\x1b[2K${next}`;
		}

		const cursorSequence = cursor
			? `\x1b[${cursor.row + 1};${cursor.column + 1}H${cursor.visible ? SHOW_CURSOR : HIDE_CURSOR}`
			: HIDE_CURSOR;
		if (body || cursorSequence !== this.#previousCursor) {
			body += cursorSequence;
			const output = this.#terminal.capabilities.synchronizedOutput ? `\x1b[?2026h${body}\x1b[?2026l` : body;
			this.#terminal.write(output);
			await this.#terminal.flushOutput();
		}
		this.#previous = Object.freeze([...screen]);
		this.#previousColumns = columns;
		this.#previousRows = rows;
		this.#previousCursor = cursorSequence;
	}
}

function validateCursor(cursor: CursorPlacement | undefined, columns: number, rows: number): void {
	if (!cursor) return;
	if (
		!Number.isInteger(cursor.row) ||
		!Number.isInteger(cursor.column) ||
		cursor.row < 0 ||
		cursor.row >= rows ||
		cursor.column < 0 ||
		cursor.column >= columns
	) {
		throw new RangeError("Cursor placement exceeds the terminal viewport");
	}
}

function validateScreen(screen: readonly string[], columns: number): void {
	for (const [row, line] of screen.entries()) {
		if (line.includes("\n") || line.includes("\r")) {
			throw new RendererInvariantError({ row, reason: "embedded-newline" });
		}
		const actualWidth = displayWidth(line);
		if (actualWidth > columns) {
			throw new RendererError({ actualWidth, availableWidth: columns, row });
		}
	}
}
