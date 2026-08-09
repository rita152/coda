import { displayWidth } from "../../src/index.ts";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export class StrictScreen {
	#columns: number;
	#rows: number;
	#main: string[][];
	#alternate: string[][];
	#usingAlternate = false;
	#cursorRow = 0;
	#cursorColumn = 0;
	#cursorVisible = true;
	#autowrap = true;
	readonly #mainKittyKeyboardStack = [0];
	readonly #alternateKittyKeyboardStack = [0];

	constructor(columns: number, rows: number) {
		this.#columns = columns;
		this.#rows = rows;
		this.#main = blankGrid(columns, rows);
		this.#alternate = blankGrid(columns, rows);
	}

	get alternateScreen(): boolean {
		return this.#usingAlternate;
	}

	get cursorVisible(): boolean {
		return this.#cursorVisible;
	}

	get cursorPosition(): { readonly row: number; readonly column: number } {
		return { row: this.#cursorRow, column: this.#cursorColumn };
	}

	get autowrap(): boolean {
		return this.#autowrap;
	}

	get kittyKeyboardFlags(): { readonly main: number; readonly alternate: number } {
		return {
			main: this.#mainKittyKeyboardStack.at(-1) ?? 0,
			alternate: this.#alternateKittyKeyboardStack.at(-1) ?? 0,
		};
	}

	resize(columns: number, rows: number): void {
		this.#main = resizeGrid(this.#main, columns, rows);
		this.#alternate = resizeGrid(this.#alternate, columns, rows);
		this.#columns = columns;
		this.#rows = rows;
		this.#cursorRow = Math.min(this.#cursorRow, rows - 1);
		this.#cursorColumn = Math.min(this.#cursorColumn, columns - 1);
	}

	write(output: string): readonly string[] {
		const responses: string[] = [];
		let offset = 0;
		while (offset < output.length) {
			if (output[offset] === "\x1b") {
				const consumed = this.#consumeEscape(output, offset);
				offset = consumed.offset;
				if (consumed.response) responses.push(consumed.response);
				continue;
			}
			const segment = segmenter.segment(output.slice(offset))[Symbol.iterator]().next().value?.segment;
			if (!segment) throw new Error(`Unable to segment terminal output at byte ${offset}`);
			this.#writeGrapheme(segment);
			offset += segment.length;
		}
		return responses;
	}

	viewport(): string[] {
		return this.#grid().map((row) => row.join("").trimEnd());
	}

	#consumeEscape(output: string, offset: number): { readonly offset: number; readonly response?: string } {
		if (output[offset + 1] === "]") {
			const bell = output.indexOf("\x07", offset + 2);
			const stringTerminator = output.indexOf("\x1b\\", offset + 2);
			const end = [bell, stringTerminator].filter((value) => value >= 0).sort((a, b) => a - b)[0];
			if (end === undefined) throw new Error(`Unterminated OSC sequence at byte ${offset}`);
			return { offset: end === bell ? end + 1 : end + 2 };
		}
		if (output[offset + 1] !== "[") throw new Error(`Unsupported escape sequence at byte ${offset}`);
		const match = /^([?<>]?[0-9;]*)([@-~])/.exec(output.slice(offset + 2));
		if (!match) throw new Error(`Malformed CSI sequence at byte ${offset}`);
		const response = this.#applyCsi(match[1] ?? "", match[2] ?? "");
		return { offset: offset + 2 + match[0].length, ...(response ? { response } : {}) };
	}

	#applyCsi(parameters: string, final: string): string | undefined {
		if (final === "u") {
			const stack = this.#kittyKeyboardStack();
			if (parameters === "?") return `\x1b[?${stack.at(-1) ?? 0}u`;
			if (parameters.startsWith(">")) {
				stack.push(Number(parameters.slice(1) || "0"));
				return;
			}
			if (parameters.startsWith("<")) {
				const count = Number(parameters.slice(1) || "1");
				for (let index = 0; index < count; index++) {
					if (stack.length > 1) stack.pop();
					else stack[0] = 0;
				}
				return;
			}
		}
		if (parameters.startsWith("?")) {
			const enabled = final === "h";
			if (final !== "h" && final !== "l") throw new Error(`Unsupported private CSI final ${final}`);
			switch (parameters) {
				case "?1049":
					this.#usingAlternate = enabled;
					if (enabled) {
						this.#alternate = blankGrid(this.#columns, this.#rows);
						this.#cursorRow = 0;
						this.#cursorColumn = 0;
					}
					return;
				case "?7":
					this.#autowrap = enabled;
					return;
				case "?25":
					this.#cursorVisible = enabled;
					return;
				case "?2026":
				case "?1003":
				case "?1006":
				case "?2004":
					return;
				default:
					throw new Error(`Unsupported private CSI ${parameters}${final}`);
			}
		}

		switch (final) {
			case "H": {
				const [row = "1", column = "1"] = parameters.split(";");
				this.#cursorRow = clamp(Number(row) - 1, 0, this.#rows - 1);
				this.#cursorColumn = clamp(Number(column) - 1, 0, this.#columns - 1);
				return;
			}
			case "J":
				if (parameters !== "2") throw new Error(`Unsupported erase-display CSI ${parameters}${final}`);
				this.#replaceGrid(blankGrid(this.#columns, this.#rows));
				return;
			case "K":
				if (parameters !== "2") throw new Error(`Unsupported erase-line CSI ${parameters}${final}`);
				this.#grid()[this.#cursorRow] = blankRow(this.#columns);
				return;
			case "m":
				return;
			default:
				throw new Error(`Unsupported CSI ${parameters}${final}`);
		}
	}

	#writeGrapheme(grapheme: string): void {
		if (grapheme === "\r") {
			this.#cursorColumn = 0;
			return;
		}
		if (grapheme === "\n") {
			this.#cursorRow = Math.min(this.#rows - 1, this.#cursorRow + 1);
			return;
		}
		const width = displayWidth(grapheme);
		if (width === 0) {
			const column = Math.max(0, this.#cursorColumn - 1);
			this.#grid()[this.#cursorRow]![column] += grapheme;
			return;
		}
		if (this.#cursorColumn + width > this.#columns) {
			throw new Error(`Text overflows row ${this.#cursorRow + 1} at column ${this.#cursorColumn + 1}`);
		}
		const row = this.#grid()[this.#cursorRow]!;
		row[this.#cursorColumn] = grapheme;
		for (let index = 1; index < width; index++) row[this.#cursorColumn + index] = "";
		this.#cursorColumn += width;
	}

	#grid(): string[][] {
		return this.#usingAlternate ? this.#alternate : this.#main;
	}

	#kittyKeyboardStack(): number[] {
		return this.#usingAlternate ? this.#alternateKittyKeyboardStack : this.#mainKittyKeyboardStack;
	}

	#replaceGrid(grid: string[][]): void {
		if (this.#usingAlternate) this.#alternate = grid;
		else this.#main = grid;
	}
}

function blankRow(columns: number): string[] {
	return Array.from({ length: columns }, () => " ");
}

function blankGrid(columns: number, rows: number): string[][] {
	return Array.from({ length: rows }, () => blankRow(columns));
}

function resizeGrid(grid: string[][], columns: number, rows: number): string[][] {
	const resized = blankGrid(columns, rows);
	for (let row = 0; row < Math.min(rows, grid.length); row++) {
		for (let column = 0; column < Math.min(columns, grid[row]?.length ?? 0); column++) {
			resized[row]![column] = grid[row]![column] ?? " ";
		}
	}
	return resized;
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(maximum, Math.max(minimum, value));
}
