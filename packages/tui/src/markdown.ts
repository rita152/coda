import type {
	Blockquote,
	Code,
	Definition,
	Heading,
	Html,
	List,
	ListItem,
	Paragraph,
	PhrasingContent,
	Root,
	RootContent,
	Table,
	TableCell,
} from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { clipAnsi, displayWidth, sanitizeTerminalText, styleAnsi, wrapAnsi } from "./ansi.ts";
import type { ColorLevel } from "./terminal.ts";

export interface MarkdownRenderOptions {
	readonly width: number;
	readonly phase: "streaming" | "complete";
}

export interface MarkdownRenderer {
	render(source: string, options: MarkdownRenderOptions): readonly string[];
}

export interface MarkdownRendererOptions {
	readonly colorLevel: ColorLevel;
}

interface RenderState {
	readonly width: number;
	readonly styles: MarkdownStyles;
	readonly definitions: ReadonlyMap<string, Definition>;
}

interface MarkdownStyles {
	readonly heading: (value: string) => string;
	readonly strong: (value: string) => string;
	readonly emphasis: (value: string) => string;
	readonly deletion: (value: string) => string;
	readonly code: (value: string) => string;
}

const COMPLETE_CACHE_LIMIT = 64;

class GfmMarkdownRenderer implements MarkdownRenderer {
	readonly #styles: MarkdownStyles;
	readonly #completeCache = new Map<string, readonly string[]>();

	constructor(options: MarkdownRendererOptions) {
		this.#styles = markdownStyles(options.colorLevel);
	}

	render(source: string, options: MarkdownRenderOptions): readonly string[] {
		assertWidth(options.width);
		const safeSource = sanitizeTerminalText(source);
		const cacheKey = `${options.width}\0${safeSource}`;
		if (options.phase === "complete") {
			const cached = this.#completeCache.get(cacheKey);
			if (cached) return cached;
		}

		let root: Root;
		try {
			root = fromMarkdown(safeSource, {
				extensions: [gfm()],
				mdastExtensions: [gfmFromMarkdown()],
			});
		} catch {
			const fallback = Object.freeze(renderWrappedText(safeSource, options.width));
			if (options.phase === "complete") this.#remember(cacheKey, fallback);
			return fallback;
		}

		const definitions = new Map<string, Definition>();
		for (const child of root.children) {
			if (child.type === "definition") definitions.set(child.identifier.toLowerCase(), child);
		}
		const state: RenderState = { width: options.width, styles: this.#styles, definitions };
		const lines = Object.freeze(renderRoot(root, state));
		if (options.phase === "complete") this.#remember(cacheKey, lines);
		return lines;
	}

	#remember(key: string, lines: readonly string[]): void {
		this.#completeCache.set(key, lines);
		if (this.#completeCache.size <= COMPLETE_CACHE_LIMIT) return;
		const oldest = this.#completeCache.keys().next().value;
		if (oldest !== undefined) this.#completeCache.delete(oldest);
	}
}

export function createMarkdownRenderer(options: MarkdownRendererOptions): MarkdownRenderer {
	return new GfmMarkdownRenderer(options);
}

function renderRoot(root: Root, state: RenderState): string[] {
	const lines: string[] = [];
	for (const child of root.children) {
		if (child.type === "definition") continue;
		const block = renderBlock(child, state);
		if (block.length === 0) continue;
		if (lines.length > 0 && lines.at(-1) !== "") lines.push("");
		lines.push(...block);
	}
	return lines;
}

function renderBlock(node: RootContent, state: RenderState): string[] {
	switch (node.type) {
		case "paragraph":
			return renderParagraph(node, state);
		case "heading":
			return renderHeading(node, state);
		case "blockquote":
			return renderBlockquote(node, state);
		case "list":
			return renderList(node, state);
		case "code":
			return renderCode(node, state);
		case "table":
			return renderTable(node, state);
		case "html":
			return renderHtml(node, state);
		case "thematicBreak":
			return ["─".repeat(Math.max(1, state.width))];
		default:
			return renderUnknownBlock(node, state);
	}
}

function renderParagraph(node: Paragraph, state: RenderState): string[] {
	return renderWrappedText(renderPhrasing(node.children, state), state.width);
}

function renderHeading(node: Heading, state: RenderState): string[] {
	return renderWrappedText(state.styles.heading(renderPhrasing(node.children, state)), state.width);
}

function renderBlockquote(node: Blockquote, state: RenderState): string[] {
	const innerWidth = Math.max(1, state.width - 2);
	const innerState = { ...state, width: innerWidth };
	const inner = renderRoot({ type: "root", children: node.children }, innerState);
	return inner.map((line) => clipAnsi(`│ ${line}`, state.width));
}

function renderList(node: List, state: RenderState): string[] {
	const lines: string[] = [];
	const start = node.start ?? 1;
	for (const [itemIndex, item] of node.children.entries()) {
		const marker = node.ordered ? `${start + itemIndex}. ` : (taskMarker(item) ?? "- ");
		const body = renderListItem(item, Math.max(1, state.width - displayWidth(marker)), state);
		if (body.length === 0) {
			lines.push(clipAnsi(marker.trimEnd(), state.width));
			continue;
		}
		lines.push(clipAnsi(`${marker}${body[0]}`, state.width));
		const indent = " ".repeat(displayWidth(marker));
		for (const continuation of body.slice(1)) lines.push(clipAnsi(`${indent}${continuation}`, state.width));
	}
	return lines;
}

function taskMarker(item: ListItem): string | undefined {
	if (item.checked === true) return "- [x] ";
	if (item.checked === false) return "- [ ] ";
	return undefined;
}

function renderListItem(item: ListItem, width: number, state: RenderState): string[] {
	const itemState = { ...state, width };
	const lines: string[] = [];
	for (const child of item.children) {
		const rendered = renderBlock(child, itemState);
		if (lines.length > 0 && rendered.length > 0) lines.push("");
		lines.push(...rendered);
	}
	return lines;
}

function renderCode(node: Code, state: RenderState): string[] {
	const label =
		sanitizeTerminalText(node.lang ?? "code")
			.replace(/\s+/g, " ")
			.trim() || "code";
	const lines = [clipAnsi(`┌─ ${label}`, state.width)];
	const prefix = "│ ";
	const continuation = "│ ↳ ";
	const contentWidth = Math.max(1, state.width - displayWidth(continuation));
	for (const logicalLine of node.value.split("\n")) {
		const wrapped = logicalLine ? wrapAnsi(state.styles.code(logicalLine), contentWidth) : [""];
		for (const [index, line] of wrapped.entries()) {
			lines.push(clipAnsi(`${index === 0 ? prefix : continuation}${line}`, state.width));
		}
	}
	return lines;
}

function renderTable(node: Table, state: RenderState): string[] {
	const cells = node.children.map((row) => row.children.map((cell) => tableCellText(cell, state)));
	const columnCount = Math.max(0, ...cells.map((row) => row.length));
	if (columnCount === 0) return [];
	const widths = Array.from({ length: columnCount }, (_, column) =>
		Math.max(0, ...cells.map((row) => displayWidth(row[column] ?? ""))),
	);
	const totalWidth = widths.reduce((sum, width) => sum + width, 0) + Math.max(0, columnCount - 1) * 2;
	if (totalWidth <= state.width) {
		return cells.map((row) =>
			row
				.map((cell, column) => alignCell(cell, widths[column] ?? 0, node.align?.[column] ?? null))
				.join("  ")
				.trimEnd(),
		);
	}

	const headers = cells[0] ?? [];
	const lines: string[] = [];
	for (const [rowIndex, row] of cells.slice(1).entries()) {
		if (rowIndex > 0) lines.push("");
		for (let column = 0; column < columnCount; column++) {
			const label = headers[column] || `Column ${column + 1}`;
			lines.push(...renderWrappedText(`${label}: ${row[column] ?? ""}`, state.width));
		}
	}
	return lines;
}

function tableCellText(cell: TableCell, state: RenderState): string {
	return renderPhrasing(cell.children, state).replace(/\s+/g, " ").trim();
}

function alignCell(value: string, width: number, alignment: "left" | "right" | "center" | null): string {
	const padding = Math.max(0, width - displayWidth(value));
	if (alignment === "right") return `${" ".repeat(padding)}${value}`;
	if (alignment === "center") {
		const left = Math.floor(padding / 2);
		return `${" ".repeat(left)}${value}${" ".repeat(padding - left)}`;
	}
	return `${value}${" ".repeat(padding)}`;
}

function renderHtml(node: Html, state: RenderState): string[] {
	return renderWrappedText(node.value, state.width);
}

function renderUnknownBlock(node: RootContent, state: RenderState): string[] {
	if ("children" in node && Array.isArray(node.children)) {
		const children = node.children.filter((child) => typeof child === "object" && child !== null) as RootContent[];
		return renderRoot({ type: "root", children }, state);
	}
	if ("value" in node && typeof node.value === "string") return renderWrappedText(node.value, state.width);
	return [];
}

function renderPhrasing(nodes: readonly PhrasingContent[], state: RenderState): string {
	let output = "";
	for (const node of nodes) {
		switch (node.type) {
			case "text":
				output += node.value;
				break;
			case "strong":
				output += state.styles.strong(renderPhrasing(node.children, state));
				break;
			case "emphasis":
				output += state.styles.emphasis(renderPhrasing(node.children, state));
				break;
			case "delete":
				output += state.styles.deletion(renderPhrasing(node.children, state));
				break;
			case "inlineCode":
				output += state.styles.code(node.value);
				break;
			case "break":
				output += "\n";
				break;
			case "html":
				output += node.value;
				break;
			case "link":
				output += renderLink(renderPhrasing(node.children, state), node.url);
				break;
			case "linkReference": {
				const definition = state.definitions.get(node.identifier.toLowerCase());
				output += definition
					? renderLink(renderPhrasing(node.children, state), definition.url)
					: renderPhrasing(node.children, state);
				break;
			}
			case "image":
				output += renderImage(node.alt ?? "image", node.url);
				break;
			case "imageReference": {
				const definition = state.definitions.get(node.identifier.toLowerCase());
				output += renderImage(node.alt ?? "image", definition?.url);
				break;
			}
			default:
				if ("children" in node) output += renderPhrasing(node.children as PhrasingContent[], state);
				else if ("value" in node && typeof node.value === "string") output += node.value;
		}
	}
	return output;
}

function renderLink(label: string, destination: string): string {
	const safe = safeLinkDestination(destination);
	return safe ? `\x1b]8;;${safe}\x1b\\${label}\x1b]8;;\x1b\\` : label;
}

function renderImage(alt: string, destination: string | undefined): string {
	return destination ? `[${alt}] (${destination})` : `[${alt}]`;
}

function safeLinkDestination(destination: string): string | undefined {
	try {
		const url = new URL(destination);
		if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "mailto:") return undefined;
		return destination;
	} catch {
		return undefined;
	}
}

function renderWrappedText(value: string, width: number): string[] {
	return value.split("\n").flatMap((line) => (line ? wrapAnsi(line, width) : [""]));
}

function markdownStyles(colorLevel: ColorLevel): MarkdownStyles {
	if (colorLevel === 0) {
		const identity = (value: string) => value;
		return { heading: identity, strong: identity, emphasis: identity, deletion: identity, code: identity };
	}
	return {
		heading: (value) => styleAnsi("1;36", value),
		strong: (value) => styleAnsi("1", value),
		emphasis: (value) => styleAnsi("3", value),
		deletion: (value) => styleAnsi("9", value),
		code: (value) => styleAnsi("36", value),
	};
}

function assertWidth(width: number): void {
	if (!Number.isSafeInteger(width) || width < 1) throw new RangeError("Markdown width must be a positive integer");
}
