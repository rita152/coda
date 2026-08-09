// Portions derived from Pi:
// /packages/tui/src/utils.ts @ 958c13f25080b59d4b736193f972a8502a7a2f8b
// Copyright (c) 2025 Mario Zechner
// SPDX-License-Identifier: MIT
// See THIRD_PARTY_NOTICES.md.

import { eastAsianWidth } from "get-east-asian-width";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
// biome-ignore lint/complexity/useRegexLiterals: the v flag requires an ES2024 TypeScript target, while Coda emits ES2022.
const rgiEmoji = new RegExp("^\\p{RGI_Emoji}$", "v");
const invisibleGrapheme = /^(?:\p{Control}|\p{Format}|\p{Mark})+$/u;
const printableBase = /[^\p{Control}\p{Format}\p{Mark}]/u;
// biome-ignore lint/complexity/useRegexLiterals: a literal is rejected because it contains the ESC control character.
const sgrReset = new RegExp("\\x1b\\[(?:0)?m", "g");

interface ControlToken {
	readonly kind: "control";
	readonly value: string;
}

interface GraphemeToken {
	readonly kind: "grapheme";
	readonly value: string;
	readonly width: number;
}

interface NewlineToken {
	readonly kind: "newline";
	readonly value: "\n";
}

interface TabToken {
	readonly kind: "tab";
	readonly value: "\t";
}

type AnsiToken = ControlToken | GraphemeToken | NewlineToken | TabToken;

interface AnsiState {
	readonly sgr: string[];
	linkOpen?: string;
	linkClose?: string;
}

export interface AnsiOptions {
	readonly tabWidth?: number;
}

export interface ClipAnsiOptions extends AnsiOptions {
	readonly ellipsis?: string;
}

function assertWidth(width: number, allowZero: boolean): void {
	if (!Number.isSafeInteger(width) || width < (allowZero ? 0 : 1)) {
		throw new RangeError(`Terminal width must be ${allowZero ? "non-negative" : "positive"}, received ${width}`);
	}
}

function normalizedTabWidth(options: AnsiOptions): number {
	const width = options.tabWidth ?? 4;
	if (!Number.isSafeInteger(width) || width < 1) {
		throw new RangeError(`Tab width must be positive, received ${width}`);
	}
	return width;
}

function tabCellWidth(column: number, tabWidth: number): number {
	return tabWidth - (column % tabWidth);
}

function graphemeCellWidth(segment: string): number {
	if (invisibleGrapheme.test(segment)) return 0;
	if (rgiEmoji.test(segment)) return 2;

	const first = segment.match(printableBase)?.[0];
	const codePoint = first?.codePointAt(0);
	if (codePoint === undefined) return 0;
	if (codePoint >= 0x1f000 && codePoint <= 0x1fbff) return 2;
	if (segment.includes("\uFE0F") || segment.includes("\u200D")) return 2;
	return eastAsianWidth(codePoint);
}

function readControl(text: string, offset: number): string | undefined {
	if (text.charCodeAt(offset) !== 0x1b) return undefined;
	if (offset + 1 >= text.length) return "\x1b";

	const introducer = text[offset + 1];
	if (introducer === "[") {
		for (let index = offset + 2; index < text.length; index++) {
			const code = text.charCodeAt(index);
			if (code >= 0x40 && code <= 0x7e) return text.slice(offset, index + 1);
		}
		return text.slice(offset);
	}

	if (introducer === "]" || introducer === "_" || introducer === "P" || introducer === "^") {
		for (let index = offset + 2; index < text.length; index++) {
			if (text.charCodeAt(index) === 0x07) return text.slice(offset, index + 1);
			if (text.charCodeAt(index) === 0x1b && text[index + 1] === "\\") return text.slice(offset, index + 2);
		}
		return text.slice(offset);
	}

	return text.slice(offset, offset + 2);
}

function tokenize(text: string): AnsiToken[] {
	const tokens: AnsiToken[] = [];
	let offset = 0;
	while (offset < text.length) {
		const control = readControl(text, offset);
		if (control !== undefined) {
			tokens.push({ kind: "control", value: control });
			offset += control.length;
			continue;
		}

		if (text[offset] === "\r" || text[offset] === "\n") {
			if (text[offset] === "\r" && text[offset + 1] === "\n") offset++;
			tokens.push({ kind: "newline", value: "\n" });
			offset++;
			continue;
		}
		if (text[offset] === "\t") {
			tokens.push({ kind: "tab", value: "\t" });
			offset++;
			continue;
		}

		let end = offset + 1;
		while (
			end < text.length &&
			text.charCodeAt(end) !== 0x1b &&
			text[end] !== "\r" &&
			text[end] !== "\n" &&
			text[end] !== "\t"
		) {
			end++;
		}
		for (const { segment } of graphemes.segment(text.slice(offset, end))) {
			tokens.push({ kind: "grapheme", value: segment, width: graphemeCellWidth(segment) });
		}
		offset = end;
	}
	return tokens;
}

function applyControl(state: AnsiState, control: string): void {
	const csi = control.startsWith("\x1b[") ? control.slice(2) : undefined;
	if (csi !== undefined && /^[0-9:;]*m$/.test(csi)) {
		if (/^(?:0|)m$/.test(csi)) state.sgr.length = 0;
		else state.sgr.push(control);
		return;
	}

	if (!control.startsWith("\x1b]8;")) return;
	const terminator = control.endsWith("\x07") ? "\x07" : control.endsWith("\x1b\\") ? "\x1b\\" : undefined;
	if (!terminator) return;
	const body = control.slice(4, -terminator.length);
	const separator = body.indexOf(";");
	if (separator < 0) return;
	const url = body.slice(separator + 1);
	if (url) {
		state.linkOpen = control;
		state.linkClose = `\x1b]8;;${terminator}`;
	} else {
		state.linkOpen = undefined;
		state.linkClose = undefined;
	}
}

function activePrefix(state: AnsiState): string {
	return `${state.sgr.join("")}${state.linkOpen ?? ""}`;
}

function activeSuffix(state: AnsiState): string {
	return `${state.linkClose ?? ""}${state.sgr.length > 0 ? "\x1b[0m" : ""}`;
}

export function stripAnsi(text: string): string {
	return tokenize(text)
		.filter((token) => token.kind !== "control")
		.map((token) => token.value)
		.join("");
}

/** Applies trusted SGR parameters while restoring them after nested full resets. */
export function styleAnsi(parameters: string, value: string): string {
	if (value.length === 0) return value;
	const open = `\x1b[${parameters}m`;
	return `${open}${value.replace(sgrReset, (reset) => `${reset}${open}`)}\x1b[0m`;
}

/** Removes untrusted terminal controls before presentation code adds its own escapes. */
export function sanitizeTerminalText(text: string): string {
	let output = "";
	let offset = 0;
	while (offset < text.length) {
		const code = text.charCodeAt(offset);
		if (code === 0x1b) {
			const control = readControl(text, offset);
			offset += control?.length ?? 1;
			continue;
		}
		if (code === 0x9b) {
			offset = skipCsi(text, offset + 1);
			continue;
		}
		if (code === 0x90 || code === 0x98 || code === 0x9d || code === 0x9e || code === 0x9f) {
			offset = skipControlString(text, offset + 1, code === 0x9d);
			continue;
		}
		if (code === 0x0d) {
			output += "\n";
			offset += text.charCodeAt(offset + 1) === 0x0a ? 2 : 1;
			continue;
		}
		if (code === 0x0a || code === 0x09) {
			output += text[offset];
			offset++;
			continue;
		}
		if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
			offset++;
			continue;
		}
		const codePoint = text.codePointAt(offset);
		if (codePoint === undefined) break;
		output += String.fromCodePoint(codePoint);
		offset += codePoint > 0xffff ? 2 : 1;
	}
	return output;
}

function skipCsi(text: string, offset: number): number {
	for (let index = offset; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code >= 0x40 && code <= 0x7e) return index + 1;
	}
	return text.length;
}

function skipControlString(text: string, offset: number, bellTerminates: boolean): number {
	for (let index = offset; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if ((bellTerminates && code === 0x07) || code === 0x9c) return index + 1;
		if (code === 0x1b && text[index + 1] === "\\") return index + 2;
	}
	return text.length;
}

export function displayWidth(text: string, options: AnsiOptions = {}): number {
	const tabWidth = normalizedTabWidth(options);
	let column = 0;
	let maximum = 0;
	for (const token of tokenize(text)) {
		switch (token.kind) {
			case "control":
				break;
			case "newline":
				maximum = Math.max(maximum, column);
				column = 0;
				break;
			case "tab":
				column += tabCellWidth(column, tabWidth);
				break;
			case "grapheme":
				column += token.width;
				break;
		}
	}
	return Math.max(maximum, column);
}

export function clipAnsi(text: string, width: number, options: ClipAnsiOptions = {}): string {
	assertWidth(width, true);
	const tabWidth = normalizedTabWidth(options);
	if (width === 0) return "";
	if (!text.includes("\n") && !text.includes("\r") && displayWidth(text, options) <= width) return text;

	const ellipsis = options.ellipsis ?? "";
	const ellipsisWidth = displayWidth(ellipsis, options);
	if (ellipsisWidth > width) return "";
	const available = width - ellipsisWidth;
	const state: AnsiState = { sgr: [] };
	let output = "";
	let column = 0;
	let truncated = false;

	for (const token of tokenize(text)) {
		if (token.kind === "control") {
			output += token.value;
			applyControl(state, token.value);
			continue;
		}
		if (token.kind === "newline") {
			truncated = true;
			break;
		}
		const tokenWidth = token.kind === "tab" ? tabCellWidth(column, tabWidth) : token.width;
		if (column + tokenWidth > available) {
			truncated = true;
			break;
		}
		output += token.value;
		column += tokenWidth;
	}

	if (!truncated) return output;
	output += activeSuffix(state);
	if (ellipsis) output += `${ellipsis}\x1b[0m`;
	return output;
}

export function sliceAnsi(text: string, start: number, width: number, options: AnsiOptions = {}): string {
	assertWidth(start, true);
	assertWidth(width, true);
	if (width === 0) return "";
	const tabWidth = normalizedTabWidth(options);
	const state: AnsiState = { sgr: [] };
	let sourceColumn = 0;
	let output = "";
	let began = false;

	for (const token of tokenize(text)) {
		if (token.kind === "newline") break;
		if (token.kind === "control") {
			applyControl(state, token.value);
			if (began) output += token.value;
			continue;
		}

		const tokenWidth = token.kind === "tab" ? tabCellWidth(sourceColumn, tabWidth) : token.width;
		const tokenStart = sourceColumn;
		const tokenEnd = sourceColumn + tokenWidth;
		sourceColumn = tokenEnd;
		if (tokenEnd <= start) continue;
		if (tokenStart >= start + width) break;
		if (tokenStart < start || tokenEnd > start + width) continue;
		if (!began) {
			output += activePrefix(state);
			began = true;
		}
		output += token.kind === "tab" ? " ".repeat(tokenWidth) : token.value;
	}

	return began ? output + activeSuffix(state) : "";
}

export function wrapAnsi(text: string, width: number, options: AnsiOptions = {}): string[] {
	assertWidth(width, false);
	const tabWidth = normalizedTabWidth(options);
	const state: AnsiState = { sgr: [] };
	const lines: string[] = [];
	let line = "";
	let column = 0;

	const finishLine = (): void => {
		lines.push(line + activeSuffix(state));
		line = activePrefix(state);
		column = 0;
	};

	for (const token of tokenize(text)) {
		if (token.kind === "control") {
			line += token.value;
			applyControl(state, token.value);
			continue;
		}
		if (token.kind === "newline") {
			finishLine();
			continue;
		}

		let tokenWidth = token.kind === "tab" ? tabCellWidth(column, tabWidth) : token.width;
		if (tokenWidth > width) {
			throw new RangeError(`A grapheme occupies ${tokenWidth} cells and cannot fit within width ${width}`);
		}
		if (column > 0 && column + tokenWidth > width) {
			finishLine();
			tokenWidth = token.kind === "tab" ? tabCellWidth(column, tabWidth) : token.width;
		}
		line += token.value;
		column += tokenWidth;
	}

	if (line.length > 0 || lines.length === 0) lines.push(line + activeSuffix(state));
	return lines;
}
