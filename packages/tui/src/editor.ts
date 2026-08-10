import { clipAnsi, displayWidth, sanitizeTerminalText } from "./ansi.ts";
import type { TerminalInput } from "./input.ts";

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });

export type EditorCursorMode = "native" | "software";

export interface EditorRenderOptions {
	readonly width: number;
	readonly height: number;
	readonly focused: boolean;
	readonly cursorMode: EditorCursorMode;
	readonly styleBorder: (value: string) => string;
	/** Optional first-line prompt prefix. Continuation rows receive an equal-width blank indent. */
	readonly prefix?: string;
}

export interface EditorCursorPlacement {
	readonly row: number;
	readonly column: number;
	readonly visible: boolean;
}

export interface EditorFrame {
	readonly lines: readonly string[];
	readonly cursor?: EditorCursorPlacement;
}

/** A logical range that follows non-overlapping edits and is removed when its text is edited. */
export interface EditorMarker<T = unknown> {
	readonly id: string;
	readonly start: number;
	readonly end: number;
	readonly value: T;
}

export type EditorInputResult =
	| { readonly type: "handled" }
	| {
			readonly type: "submit";
			readonly text: string;
			readonly alternate?: true;
			readonly markers?: readonly EditorMarker[];
	  }
	| { readonly type: "unhandled" };

declare const editorStateBrand: unique symbol;

/** Opaque Editor-owned state suitable for exact draft restoration. */
export interface EditorState {
	readonly [editorStateBrand]: true;
}

export class Editor {
	#text = "";
	#cursor = 0;
	#scrollTop = 0;
	#lastRenderWidth = 80;
	#lastRenderHeight = 24;
	#preferredColumn?: number;
	#lastYank?: { start: number; end: number; ringIndex: number };
	#pasteCounter = 0;
	#pastes = new Map<string, string>();
	#markers: EditorMarker[] = [];
	readonly #undo: EditorSnapshot[] = [];
	readonly #killRing: string[] = [];

	get text(): string {
		return this.#text;
	}

	get cursorOffset(): number {
		return this.#cursor;
	}

	get markers(): readonly EditorMarker[] {
		return Object.freeze(this.#markers.map(cloneMarker));
	}

	addMarker<T>(marker: EditorMarker<T>): void {
		if (!marker.id) throw new Error("Editor marker identity must not be empty");
		if (
			!Number.isInteger(marker.start) ||
			!Number.isInteger(marker.end) ||
			marker.start < 0 ||
			marker.start >= marker.end ||
			marker.end > this.#text.length
		) {
			throw new RangeError(`Invalid editor marker range: ${marker.start}..${marker.end}`);
		}
		if (this.#markers.some(({ id }) => id === marker.id)) {
			throw new Error(`Editor marker identity already exists: ${marker.id}`);
		}
		this.#markers.push(Object.freeze({ ...marker }));
		this.#markers.sort(compareMarkers);
	}

	replaceRange(start: number, end: number, value: string): void {
		if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end || end > this.#text.length) {
			throw new RangeError(`Invalid editor range: ${start}..${end}`);
		}
		this.#pushUndo();
		this.#replaceText(start, end, value);
		this.#cursor = start + value.length;
		this.#scrollTop = 0;
		this.#resetMovementState();
	}

	captureState(): EditorState {
		return Object.freeze({
			text: this.#text,
			cursor: this.#cursor,
			scrollTop: this.#scrollTop,
			lastRenderWidth: this.#lastRenderWidth,
			lastRenderHeight: this.#lastRenderHeight,
			preferredColumn: this.#preferredColumn,
			lastYank: this.#lastYank ? { ...this.#lastYank } : undefined,
			pasteCounter: this.#pasteCounter,
			pastes: new Map(this.#pastes),
			markers: this.#markers.map(cloneMarker),
			undo: this.#undo.map(cloneSnapshot),
			killRing: [...this.#killRing],
		}) as unknown as EditorState;
	}

	restoreState(state: EditorState): void {
		const snapshot = state as unknown as EditorStateSnapshot;
		this.#text = snapshot.text;
		this.#cursor = snapshot.cursor;
		this.#scrollTop = snapshot.scrollTop;
		this.#lastRenderWidth = snapshot.lastRenderWidth;
		this.#lastRenderHeight = snapshot.lastRenderHeight;
		this.#preferredColumn = snapshot.preferredColumn;
		this.#lastYank = snapshot.lastYank ? { ...snapshot.lastYank } : undefined;
		this.#pasteCounter = snapshot.pasteCounter;
		this.#pastes = new Map(snapshot.pastes);
		this.#markers = snapshot.markers.map(cloneMarker);
		this.#undo.splice(0, this.#undo.length, ...snapshot.undo.map(cloneSnapshot));
		this.#killRing.splice(0, this.#killRing.length, ...snapshot.killRing);
	}

	canMoveVertical(direction: -1 | 1): boolean {
		const points = editorCursorPoints(this.#text, this.#lastRenderWidth);
		const current = points.find((point) => point.offset === this.#cursor);
		if (!current) return false;
		const lastRow = points.at(-1)?.row ?? 0;
		return direction < 0 ? current.row > 0 : current.row < lastRow;
	}

	setText(value: string): void {
		this.#pushUndo();
		this.#text = value;
		this.#markers = [];
		this.#cursor = value.length;
		this.#scrollTop = 0;
	}

	absorbPrefix(prefix: string): boolean {
		if (!prefix || !this.#text.startsWith(prefix)) return false;
		this.#replaceText(0, prefix.length, "");
		this.#cursor = Math.max(0, this.#cursor - prefix.length);
		this.#scrollTop = 0;
		this.#resetMovementState();
		return true;
	}

	clear(): void {
		this.setText("");
	}

	handleInput(input: TerminalInput): EditorInputResult {
		if (input.type === "paste") {
			const normalized = sanitizeTerminalText(input.text).replaceAll("\t", "    ");
			if (normalized.length === 0) return { type: "handled" };
			this.#pushUndo();
			const lineCount = normalized.split("\n").length;
			if (lineCount > 10 || normalized.length > 1_000) {
				const id = ++this.#pasteCounter;
				const marker =
					lineCount > 10 ? `[paste #${id} +${lineCount} lines]` : `[paste #${id} ${normalized.length} chars]`;
				this.#pastes.set(marker, normalized);
				this.#insert(marker);
			} else this.#insert(normalized);
			return { type: "handled" };
		}
		if (input.type === "text") {
			this.#pushUndo();
			this.#insert(input.text);
			return { type: "handled" };
		}
		if (input.type !== "key" || input.action === "release") return { type: "unhandled" };
		if (input.key === "enter") {
			if (input.shift) {
				this.#pushUndo();
				this.#insert("\n");
				return { type: "handled" };
			}
			const previous = this.#previousBoundary(this.#cursor);
			if (!input.alt && this.#text.slice(previous, this.#cursor) === "\\") {
				this.#pushUndo();
				this.#replaceText(previous, this.#cursor, "");
				this.#cursor = previous;
				this.#insert("\n");
				return { type: "handled" };
			}
			const expanded = this.#expandedSubmission();
			const submission = {
				type: "submit" as const,
				text: expanded.text,
				...(expanded.markers.length > 0 ? { markers: expanded.markers } : {}),
			};
			return input.alt ? { ...submission, alternate: true } : submission;
		}
		if (input.control && input.key === "hyphen") {
			const snapshot = this.#undo.pop();
			if (snapshot) this.#restore(snapshot);
			return { type: "handled" };
		}
		if (input.text !== undefined && !input.control && !input.alt && !input.meta) {
			this.#pushUndo();
			this.#insert(input.text);
			return { type: "handled" };
		}
		switch (input.key) {
			case "up":
				this.#moveVertical(-1);
				return { type: "handled" };
			case "down":
				this.#moveVertical(1);
				return { type: "handled" };
			case "page-up":
			case "page-down": {
				const delta = input.key === "page-up" ? -1 : 1;
				const rows = Math.max(5, Math.floor(this.#lastRenderHeight * 0.3));
				for (let row = 0; row < rows; row++) this.#moveVertical(delta);
				return { type: "handled" };
			}
			case "left":
				this.#cursor =
					input.control || input.alt
						? previousWordBoundary(this.#text, this.#cursor)
						: this.#previousBoundary(this.#cursor);
				this.#resetMovementState();
				return { type: "handled" };
			case "right":
				this.#cursor =
					input.control || input.alt
						? nextWordBoundary(this.#text, this.#cursor)
						: this.#nextBoundary(this.#cursor);
				this.#resetMovementState();
				return { type: "handled" };
			case "b":
			case "f":
				if (!input.control && !input.alt) return { type: "unhandled" };
				this.#cursor = input.key === "b" ? this.#previousBoundary(this.#cursor) : this.#nextBoundary(this.#cursor);
				this.#resetMovementState();
				return { type: "handled" };
			case "backspace": {
				const start =
					input.control || input.alt
						? previousWordBoundary(this.#text, this.#cursor)
						: this.#previousBoundary(this.#cursor);
				if (start === this.#cursor) return { type: "handled" };
				this.#pushUndo();
				if (input.control || input.alt) this.#recordKill(this.#text.slice(start, this.#cursor));
				this.#replaceText(start, this.#cursor, "");
				this.#cursor = start;
				this.#resetMovementState();
				return { type: "handled" };
			}
			case "w": {
				if (!input.control) return { type: "unhandled" };
				const start = previousWordBoundary(this.#text, this.#cursor);
				if (start === this.#cursor) return { type: "handled" };
				this.#pushUndo();
				this.#recordKill(this.#text.slice(start, this.#cursor));
				this.#replaceText(start, this.#cursor, "");
				this.#cursor = start;
				this.#resetMovementState();
				return { type: "handled" };
			}
			case "y": {
				if (input.control && this.#killRing.length > 0) {
					this.#pushUndo();
					const start = this.#cursor;
					this.#insert(this.#killRing[0]!);
					this.#lastYank = { start, end: this.#cursor, ringIndex: 0 };
					return { type: "handled" };
				}
				if (input.alt && this.#lastYank && this.#killRing.length > 1) {
					this.#pushUndo();
					const ringIndex = (this.#lastYank.ringIndex + 1) % this.#killRing.length;
					const value = this.#killRing[ringIndex]!;
					this.#replaceText(this.#lastYank.start, this.#lastYank.end, value);
					this.#cursor = this.#lastYank.start + value.length;
					this.#lastYank = { start: this.#lastYank.start, end: this.#cursor, ringIndex };
					return { type: "handled" };
				}
				return { type: "unhandled" };
			}
			case "delete":
			case "d": {
				if (input.key === "d" && !input.control && !input.alt) return { type: "unhandled" };
				const end = input.alt ? nextWordBoundary(this.#text, this.#cursor) : this.#nextBoundary(this.#cursor);
				if (end === this.#cursor) return { type: "handled" };
				this.#pushUndo();
				if (input.alt) this.#recordKill(this.#text.slice(this.#cursor, end));
				this.#replaceText(this.#cursor, end, "");
				this.#resetMovementState();
				return { type: "handled" };
			}
			case "a":
			case "home":
				if (input.key === "a" && !input.control) return { type: "unhandled" };
				this.#cursor = this.#text.lastIndexOf("\n", Math.max(0, this.#cursor - 1)) + 1;
				this.#resetMovementState();
				return { type: "handled" };
			case "e":
			case "end": {
				if (input.key === "e" && !input.control) return { type: "unhandled" };
				const newline = this.#text.indexOf("\n", this.#cursor);
				this.#cursor = newline < 0 ? this.#text.length : newline;
				this.#resetMovementState();
				return { type: "handled" };
			}
			case "u":
			case "k": {
				if (!input.control) return { type: "unhandled" };
				const lineStart = this.#text.lastIndexOf("\n", Math.max(0, this.#cursor - 1)) + 1;
				const newline = this.#text.indexOf("\n", this.#cursor);
				const lineEnd = newline < 0 ? this.#text.length : newline;
				const start = input.key === "u" ? lineStart : this.#cursor;
				const end =
					input.key === "u" ? this.#cursor : this.#cursor === lineEnd && newline >= 0 ? newline + 1 : lineEnd;
				if (start === end) return { type: "handled" };
				this.#pushUndo();
				this.#recordKill(this.#text.slice(start, end));
				this.#replaceText(start, end, "");
				this.#cursor = start;
				this.#resetMovementState();
				return { type: "handled" };
			}
			default:
				return { type: "unhandled" };
		}
	}

	render(options: EditorRenderOptions): EditorFrame {
		if (!Number.isInteger(options.width) || options.width < 1) {
			throw new RangeError("Editor width must be a positive integer");
		}
		const prefix = options.prefix ?? "";
		const prefixWidth = displayWidth(prefix);
		if (prefixWidth >= options.width) throw new RangeError("Editor prefix must leave at least one content column");
		const contentWidth = options.width - prefixWidth;
		this.#lastRenderWidth = contentWidth;
		this.#lastRenderHeight = options.height;
		const layout = layoutEditorText(this.#text, this.#cursor, contentWidth);
		const content = [...layout.lines];
		if (options.focused && options.cursorMode === "software") {
			const line = content[layout.cursorRow] ?? "";
			const current = layout.cursorGrapheme || " ";
			content[layout.cursorRow] = `${line.slice(0, layout.cursorOffset)}\x1b[7m${current}\x1b[27m${line.slice(
				layout.cursorOffset + layout.cursorGrapheme.length,
			)}`;
		}
		const maximumContentRows = Math.max(5, Math.floor(options.height * 0.3));
		const visibleRows = Math.min(content.length, maximumContentRows);
		if (layout.cursorRow < this.#scrollTop) this.#scrollTop = layout.cursorRow;
		if (layout.cursorRow >= this.#scrollTop + visibleRows) {
			this.#scrollTop = layout.cursorRow - visibleRows + 1;
		}
		this.#scrollTop = Math.max(0, Math.min(this.#scrollTop, content.length - visibleRows));
		const hiddenAbove = this.#scrollTop;
		const hiddenBelow = Math.max(0, content.length - this.#scrollTop - visibleRows);
		const topBorder = options.styleBorder(renderScrollBorder(options.width, "↑", hiddenAbove));
		const bottomBorder = options.styleBorder(renderScrollBorder(options.width, "↓", hiddenBelow));
		const blankPrefix = " ".repeat(prefixWidth);
		const visibleContent = content.slice(this.#scrollTop, this.#scrollTop + visibleRows).map((line, visibleIndex) => {
			const absoluteIndex = this.#scrollTop + visibleIndex;
			return `${absoluteIndex === 0 ? prefix : blankPrefix}${line}`;
		});
		return {
			lines: Object.freeze([topBorder, ...visibleContent, bottomBorder]),
			cursor: options.focused
				? Object.freeze({
						row: layout.cursorRow - this.#scrollTop + 1,
						column: prefixWidth + layout.cursorColumn,
						visible: options.cursorMode === "native",
					})
				: undefined,
		};
	}

	#insert(value: string): void {
		if (value.length === 0) return;
		this.#replaceText(this.#cursor, this.#cursor, value);
		this.#cursor += value.length;
		this.#preferredColumn = undefined;
		this.#lastYank = undefined;
	}

	#moveVertical(delta: -1 | 1): void {
		const points = editorCursorPoints(this.#text, this.#lastRenderWidth);
		const current = points.find((point) => point.offset === this.#cursor);
		if (!current) return;
		this.#preferredColumn ??= current.column;
		const lastRow = points.at(-1)?.row ?? 0;
		const targetRow = Math.max(0, Math.min(lastRow, current.row + delta));
		if (targetRow === current.row) return;
		const candidates = points.filter((point) => point.row === targetRow);
		const target = candidates.reduce<EditorCursorPoint | undefined>((best, candidate) => {
			if (!best) return candidate;
			const candidateDistance = Math.abs(candidate.column - this.#preferredColumn!);
			const bestDistance = Math.abs(best.column - this.#preferredColumn!);
			if (candidateDistance !== bestDistance) return candidateDistance < bestDistance ? candidate : best;
			return candidate.column < best.column ? candidate : best;
		}, undefined);
		if (target) this.#cursor = target.offset;
	}

	#previousBoundary(offset: number): number {
		for (const marker of this.#pastes.keys()) {
			const start = offset - marker.length;
			if (start >= 0 && this.#text.slice(start, offset) === marker) return start;
		}
		return previousGraphemeBoundary(this.#text, offset);
	}

	#nextBoundary(offset: number): number {
		for (const marker of this.#pastes.keys()) {
			if (this.#text.startsWith(marker, offset)) return offset + marker.length;
		}
		return nextGraphemeBoundary(this.#text, offset);
	}

	#expandedSubmission(): { readonly text: string; readonly markers: readonly EditorMarker[] } {
		let text = this.#text;
		let markers = this.#markers.map(cloneMarker);
		for (const [pasteMarker, value] of this.#pastes) {
			let searchFrom = 0;
			while (true) {
				const start = text.indexOf(pasteMarker, searchFrom);
				if (start < 0) break;
				const end = start + pasteMarker.length;
				markers = transformMarkers(markers, start, end, value.length);
				text = `${text.slice(0, start)}${value}${text.slice(end)}`;
				searchFrom = start + value.length;
			}
		}
		const trimmedStart = text.length - text.trimStart().length;
		const trimmedEnd = text.trimEnd().length;
		return Object.freeze({
			text: text.slice(trimmedStart, trimmedEnd),
			markers: Object.freeze(
				markers
					.filter((marker) => marker.start >= trimmedStart && marker.end <= trimmedEnd)
					.map((marker) =>
						Object.freeze({
							...marker,
							start: marker.start - trimmedStart,
							end: marker.end - trimmedStart,
						}),
					),
			),
		});
	}

	#pushUndo(): void {
		this.#undo.push({
			text: this.#text,
			cursor: this.#cursor,
			scrollTop: this.#scrollTop,
			pasteCounter: this.#pasteCounter,
			pastes: new Map(this.#pastes),
			markers: this.#markers.map(cloneMarker),
		});
		if (this.#undo.length > 100) this.#undo.shift();
	}

	#restore(snapshot: EditorSnapshot): void {
		this.#text = snapshot.text;
		this.#cursor = snapshot.cursor;
		this.#scrollTop = snapshot.scrollTop;
		this.#pasteCounter = snapshot.pasteCounter;
		this.#pastes = new Map(snapshot.pastes);
		this.#markers = snapshot.markers.map(cloneMarker);
	}

	#replaceText(start: number, end: number, value: string): void {
		this.#markers = transformMarkers(this.#markers, start, end, value.length);
		this.#text = `${this.#text.slice(0, start)}${value}${this.#text.slice(end)}`;
	}

	#recordKill(value: string): void {
		if (value.length === 0) return;
		this.#killRing.unshift(value);
		this.#lastYank = undefined;
		if (this.#killRing.length > 60) this.#killRing.pop();
	}

	#resetMovementState(): void {
		this.#preferredColumn = undefined;
		this.#lastYank = undefined;
	}
}

interface EditorSnapshot {
	readonly text: string;
	readonly cursor: number;
	readonly scrollTop: number;
	readonly pasteCounter: number;
	readonly pastes: ReadonlyMap<string, string>;
	readonly markers: readonly EditorMarker[];
}

interface EditorStateSnapshot extends EditorSnapshot {
	readonly lastRenderWidth: number;
	readonly lastRenderHeight: number;
	readonly preferredColumn?: number;
	readonly lastYank?: { readonly start: number; readonly end: number; readonly ringIndex: number };
	readonly undo: readonly EditorSnapshot[];
	readonly killRing: readonly string[];
}

function cloneSnapshot(snapshot: EditorSnapshot): EditorSnapshot {
	return {
		text: snapshot.text,
		cursor: snapshot.cursor,
		scrollTop: snapshot.scrollTop,
		pasteCounter: snapshot.pasteCounter,
		pastes: new Map(snapshot.pastes),
		markers: snapshot.markers.map(cloneMarker),
	};
}

function cloneMarker<T>(marker: EditorMarker<T>): EditorMarker<T> {
	return Object.freeze({ ...marker });
}

function compareMarkers(left: EditorMarker, right: EditorMarker): number {
	return left.start - right.start || left.end - right.end || left.id.localeCompare(right.id);
}

function transformMarkers(
	markers: readonly EditorMarker[],
	start: number,
	end: number,
	replacementLength: number,
): EditorMarker[] {
	const delta = replacementLength - (end - start);
	const transformed: EditorMarker[] = [];
	for (const marker of markers) {
		if (marker.end <= start) {
			transformed.push(marker);
			continue;
		}
		if (marker.start >= end) {
			transformed.push(Object.freeze({ ...marker, start: marker.start + delta, end: marker.end + delta }));
		}
	}
	return transformed;
}

function renderScrollBorder(width: number, direction: "↑" | "↓", hiddenRows: number): string {
	if (hiddenRows === 0) return "─".repeat(width);
	const label = `${direction} ${hiddenRows} more`;
	if (displayWidth(label) + 3 > width) return clipAnsi(label, width);
	return `─ ${label} ${"─".repeat(width - displayWidth(label) - 3)}`;
}

interface EditorTextLayout {
	readonly lines: readonly string[];
	readonly cursorRow: number;
	readonly cursorColumn: number;
	readonly cursorOffset: number;
	readonly cursorGrapheme: string;
}

interface EditorCursorPoint {
	readonly offset: number;
	readonly row: number;
	readonly column: number;
	readonly lineOffset: number;
}

function editorCursorPoints(value: string, width: number): readonly EditorCursorPoint[] {
	return buildVisualEditorLayout(value, width).points;
}

function layoutEditorText(value: string, cursor: number, width: number): EditorTextLayout {
	const layout = buildVisualEditorLayout(value, width);
	const point = layout.points.find((candidate) => candidate.offset === cursor) ?? layout.points[0]!;
	const nextBoundary = nextGraphemeBoundary(value, cursor);
	const candidate = value.slice(cursor, nextBoundary);
	return Object.freeze({
		lines: layout.lines,
		cursorRow: point.row,
		cursorColumn: point.column,
		cursorOffset: point.lineOffset,
		cursorGrapheme: /[\r\n]/u.test(candidate) ? "" : candidate,
	});
}

interface VisualEditorLayout {
	readonly lines: readonly string[];
	readonly points: readonly EditorCursorPoint[];
}

function buildVisualEditorLayout(value: string, width: number): VisualEditorLayout {
	const lines = [""];
	const points = new Map<number, EditorCursorPoint>();
	let row = 0;
	let column = 0;
	const setPoint = (offset: number) => {
		points.set(offset, { offset, row, column, lineOffset: lines[row]!.length });
	};
	setPoint(0);

	for (const word of wordSegmenter.segment(value)) {
		const canWrapAsWord = !/^\s+$/u.test(word.segment) && !/[\r\n]/u.test(word.segment);
		const wordWidth = displayWidth(word.segment);
		if (canWrapAsWord && wordWidth <= width && column > 0 && column + wordWidth > width) {
			row++;
			column = 0;
			lines.push("");
			setPoint(word.index);
		}

		for (const local of graphemeSegmenter.segment(word.segment)) {
			const offset = word.index + local.index;
			const end = offset + local.segment.length;
			if (local.segment === "\n" || local.segment === "\r\n" || local.segment === "\r") {
				setPoint(offset);
				row++;
				column = 0;
				lines.push("");
				setPoint(end);
				continue;
			}
			const segmentWidth = displayWidth(local.segment);
			if (column > 0 && column + segmentWidth > width) {
				row++;
				column = 0;
				lines.push("");
			}
			setPoint(offset);
			lines[row] += local.segment;
			column += segmentWidth;
			setPoint(end);
		}
	}

	if (value.length > 0 && column === width && !/[\r\n]$/u.test(value)) {
		row++;
		column = 0;
		lines.push("");
		setPoint(value.length);
	}
	return Object.freeze({
		lines: Object.freeze(lines),
		points: Object.freeze([...points.values()].sort((left, right) => left.offset - right.offset)),
	});
}

function previousGraphemeBoundary(value: string, offset: number): number {
	let previous = 0;
	for (const segment of graphemeSegmenter.segment(value)) {
		if (segment.index >= offset) break;
		previous = segment.index;
	}
	return previous;
}

function nextGraphemeBoundary(value: string, offset: number): number {
	for (const segment of graphemeSegmenter.segment(value)) {
		if (segment.index > offset) return segment.index;
	}
	return value.length;
}

function previousWordBoundary(value: string, offset: number): number {
	const segments = [...wordSegmenter.segment(value)];
	let skippingWhitespace = true;
	for (let index = segments.length - 1; index >= 0; index--) {
		const segment = segments[index]!;
		if (segment.index >= offset) continue;
		const whitespace = /^\s+$/u.test(segment.segment);
		if (skippingWhitespace && whitespace) continue;
		skippingWhitespace = false;
		return segment.index;
	}
	return 0;
}

function nextWordBoundary(value: string, offset: number): number {
	let skippingWhitespace = true;
	for (const segment of wordSegmenter.segment(value)) {
		const end = segment.index + segment.segment.length;
		if (end <= offset) continue;
		const whitespace = /^\s+$/u.test(segment.segment);
		if (skippingWhitespace && whitespace) continue;
		skippingWhitespace = false;
		return end;
	}
	return value.length;
}
