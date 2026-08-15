import type { FollowUp } from "@coda/agent";
import {
	clipAnsi,
	displayWidth,
	type MarkdownRenderer,
	sanitizeTerminalText,
	sliceAnsi,
	type TerminalInput,
	wrapAnsi,
} from "@coda/tui";
import { renderVisibleUserText } from "../skills/context.ts";
import { attachmentElementLabel } from "./attachment-label.ts";
import type { ChatAttachment } from "./chat-component.ts";
import type { TimelineEntry } from "./semantic-timeline.ts";
import type { TuiTheme } from "./theme.ts";
import { renderToolInvocation } from "./tool-presentation.ts";
import { renderUserShellEntry } from "./user-shell-presentation.ts";

export const MINIMUM_CHAT_COLUMNS = 40;
export const MINIMUM_CHAT_ROWS = 10;

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export interface PreviewGeometry {
	readonly row: number;
	readonly column: number;
	readonly width: number;
	readonly height: number;
	readonly imageRow: number;
	readonly imageColumn: number;
	readonly imageWidth: number;
	readonly imageHeight: number;
	readonly modal: boolean;
}

export interface LocalAttachmentHitRegion {
	readonly targetKey: string;
	readonly row: number;
	readonly start: number;
	readonly end: number;
}

export interface RecoverablePromptCardView {
	readonly item: FollowUp;
	readonly state: "paused" | "failed";
	readonly failure?: string;
}

export function previewGeometry(
	screenWidth: number,
	screenHeight: number,
	dockRows: number,
	attachment: ChatAttachment,
	modal: boolean,
): PreviewGeometry | undefined {
	const availableHeight = screenHeight - 1 - dockRows;
	if (availableHeight < 4 || screenWidth < 8) return undefined;
	const maximumWidth = modal ? Math.floor(screenWidth * 0.9) : Math.floor(screenWidth * 0.75);
	const maximumHeight = modal ? Math.floor(availableHeight * 0.9) : Math.floor(availableHeight * 0.75);
	const sourceWidth = attachment.preview?.width ?? attachment.width;
	const sourceHeight = attachment.preview?.height ?? attachment.height;
	const widthFromHeight = Math.max(1, Math.round((maximumHeight * sourceWidth * 2) / Math.max(1, sourceHeight)));
	const imageWidth = Math.max(1, Math.min(maximumWidth, widthFromHeight));
	const imageHeight = Math.max(
		1,
		Math.min(maximumHeight, Math.round((imageWidth * sourceHeight) / (Math.max(1, sourceWidth) * 2))),
	);
	const imageRow = 1 + Math.floor((availableHeight - imageHeight) / 2);
	const imageColumn = Math.floor((screenWidth - imageWidth) / 2);
	return {
		row: imageRow,
		column: imageColumn,
		width: imageWidth,
		height: imageHeight,
		imageRow,
		imageColumn,
		imageWidth,
		imageHeight,
		modal,
	};
}

export function renderPreviewOverlay(
	frame: readonly string[],
	geometry: PreviewGeometry,
	screenWidth: number,
): string[] {
	return frame.map((line, row) => {
		if (row < geometry.imageRow || row >= geometry.imageRow + geometry.imageHeight) return line;
		const left = sliceAnsi(line, 0, geometry.imageColumn).padEnd(geometry.imageColumn);
		const rightStart = geometry.imageColumn + geometry.imageWidth;
		const right = sliceAnsi(line, rightStart, Math.max(0, screenWidth - rightStart));
		return clipAnsi(`${left}${" ".repeat(geometry.imageWidth)}${right}`, screenWidth);
	});
}

export function renderTimelineEntry(
	entry: TimelineEntry,
	width: number,
	transcriptMode: boolean,
	markdown: MarkdownRenderer,
	theme: TuiTheme,
	now: number,
	motion: "full" | "reduced",
	toolResultImagesSupported: boolean,
): readonly string[] {
	switch (entry.kind) {
		case "user":
			return renderUserCard(entry.text, width, theme).lines;
		case "assistant":
			return markdown.render(entry.text, { width, phase: entry.phase });
		case "thinking": {
			const thinkingWidth = theme.colorLevel === 0 ? Math.max(1, width - 2) : width;
			const lines = markdown.render(entry.text, { width: thinkingWidth, phase: entry.phase });
			if (theme.colorLevel > 0) return lines.map((line) => theme.style("thinking", line));
			return ["Thinking", ...lines.map((line) => clipAnsi(`  ${line}`, width))];
		}
		case "tool":
			return renderToolInvocation(entry, {
				width,
				now,
				transcript: transcriptMode,
				theme,
				motion,
				toolResultImagesSupported,
			});
		case "user_shell":
			return renderUserShellEntry(entry, { width, now, theme });
	}
}

export function renderUserCard(
	source: string,
	width: number,
	theme: TuiTheme,
	attachments: readonly ChatAttachment[] = [],
	status?: string,
	blockId = "user",
	focusedAttachmentKey?: string,
): { readonly lines: readonly string[]; readonly regions: readonly LocalAttachmentHitRegion[] } {
	const safeSource = sanitizeTerminalText(source);
	const border = theme.style("muted", "─".repeat(width));
	const bottom = status ? theme.style("muted", renderStatusBorder(width, status)) : border;
	const inlineLayout = renderInlineTimelineAttachments(
		safeSource,
		attachments,
		width,
		blockId,
		focusedAttachmentKey,
		theme,
	);
	const unmatched = attachments.flatMap((attachment, index) =>
		inlineLayout.matchedIndexes.has(index) ? [] : [{ attachment, index }],
	);
	const attachmentLayout = renderTimelineAttachments(
		unmatched.map(({ attachment }) => attachment),
		width,
		blockId,
		focusedAttachmentKey,
		theme,
		unmatched.map(({ index }) => index),
	);
	return Object.freeze({
		lines: Object.freeze([border, ...attachmentLayout.lines, ...inlineLayout.lines, bottom]),
		regions: Object.freeze(
			[
				...attachmentLayout.regions.map((region) => ({ ...region, row: region.row + 1 })),
				...inlineLayout.regions.map((region) => ({
					...region,
					row: region.row + attachmentLayout.lines.length + 1,
				})),
			].map((region) => Object.freeze(region)),
		),
	});
}

function renderInlineTimelineAttachments(
	source: string,
	attachments: readonly ChatAttachment[],
	width: number,
	blockId: string,
	focusedAttachmentKey: string | undefined,
	theme: TuiTheme,
): {
	readonly lines: readonly string[];
	readonly regions: readonly LocalAttachmentHitRegion[];
	readonly matchedIndexes: ReadonlySet<number>;
} {
	const projection = projectTimelineAttachmentElements(source, attachments, blockId);
	const matches = projection.matches;
	const displaySource = projection.source;
	if (matches.length === 0) {
		const lines = source ? source.split("\n").flatMap((line) => (line ? wrapAnsi(line, width) : [""])) : [];
		return { lines, regions: [], matchedIndexes: new Set() };
	}

	const lines = [""];
	const regions: LocalAttachmentHitRegion[] = [];
	let row = 0;
	let column = 0;
	for (const segment of graphemeSegmenter.segment(displaySource)) {
		const match = matches.find((candidate) => segment.index >= candidate.start && segment.index < candidate.end);
		if (match?.start === segment.index) {
			const tokenWidth = displayWidth(displaySource.slice(match.start, match.end));
			if (tokenWidth <= width && column > 0 && column + tokenWidth > width) {
				lines.push("");
				row++;
				column = 0;
			}
		}
		if (/^[\r\n]+$/u.test(segment.segment)) {
			lines.push("");
			row++;
			column = 0;
			continue;
		}
		const segmentWidth = displayWidth(segment.segment);
		if (column > 0 && column + segmentWidth > width) {
			lines.push("");
			row++;
			column = 0;
		}
		lines[row] += segment.segment;
		if (match) {
			const previous = regions.at(-1);
			if (previous?.targetKey === match.targetKey && previous.row === row && previous.end === column) {
				regions[regions.length - 1] = { ...previous, end: column + segmentWidth };
			} else {
				regions.push({ targetKey: match.targetKey, row, start: column, end: column + segmentWidth });
			}
		}
		column += segmentWidth;
	}

	for (const region of [...regions].sort((left, right) => right.row - left.row || right.start - left.start)) {
		if (region.targetKey !== focusedAttachmentKey) continue;
		const line = lines[region.row] ?? "";
		const before = sliceAnsi(line, 0, region.start);
		const selected = sliceAnsi(line, region.start, region.end - region.start);
		const after = sliceAnsi(line, region.end, Math.max(0, displayWidth(line) - region.end));
		lines[region.row] = `${before}${theme.style("accent", selected)}${after}`;
	}
	return {
		lines,
		regions,
		matchedIndexes: new Set(matches.map(({ attachmentIndex }) => attachmentIndex)),
	};
}

interface TimelineAttachmentMatch {
	readonly targetKey: string;
	readonly attachmentIndex: number;
	readonly start: number;
	readonly end: number;
}

interface SourceAttachmentMatch extends TimelineAttachmentMatch {
	readonly label: string;
}

/** Restores presentation brackets around model-visible attachment filenames without changing stored message text. */
function projectTimelineAttachmentElements(
	source: string,
	attachments: readonly ChatAttachment[],
	blockId: string,
): { readonly source: string; readonly matches: readonly TimelineAttachmentMatch[] } {
	const sourceMatches: SourceAttachmentMatch[] = [];
	for (const [attachmentIndex, attachment] of attachments.entries()) {
		const label = attachmentElementLabel(attachment.filename);
		const filename = label.slice(1, -1);
		const range =
			findAvailableAttachmentFilename(source, filename, sourceMatches) ??
			findAvailableAttachmentLabel(source, label, sourceMatches);
		if (!range) continue;
		sourceMatches.push({
			targetKey: attachmentTargetKey(blockId, attachment.id, attachmentIndex),
			attachmentIndex,
			start: range.start,
			end: range.end,
			label,
		});
	}
	sourceMatches.sort((left, right) => left.start - right.start);
	if (sourceMatches.length === 0) return { source, matches: [] };

	let sourceOffset = 0;
	let displaySource = "";
	const displayMatches: TimelineAttachmentMatch[] = [];
	for (const match of sourceMatches) {
		displaySource += source.slice(sourceOffset, match.start);
		const start = displaySource.length;
		displaySource += match.label;
		displayMatches.push({
			targetKey: match.targetKey,
			attachmentIndex: match.attachmentIndex,
			start,
			end: displaySource.length,
		});
		sourceOffset = match.end;
	}
	displaySource += source.slice(sourceOffset);
	return { source: displaySource, matches: displayMatches };
}

function findAvailableAttachmentFilename(
	source: string,
	filename: string,
	occupied: readonly { readonly start: number; readonly end: number }[],
): { readonly start: number; readonly end: number } | undefined {
	if (!filename) return undefined;
	let start = source.indexOf(filename);
	while (start >= 0) {
		const end = start + filename.length;
		const alreadyBracketed = source[start - 1] === "[" && source[end] === "]";
		if (
			!alreadyBracketed &&
			isAttachmentFilenameBoundary(source, start, end) &&
			isRangeAvailable(start, end, occupied)
		) {
			return { start, end };
		}
		start = source.indexOf(filename, start + filename.length);
	}
	return undefined;
}

function findAvailableAttachmentLabel(
	source: string,
	label: string,
	occupied: readonly { readonly start: number; readonly end: number }[],
): { readonly start: number; readonly end: number } | undefined {
	let start = source.indexOf(label);
	while (start >= 0) {
		const end = start + label.length;
		if (isRangeAvailable(start, end, occupied)) return { start, end };
		start = source.indexOf(label, start + label.length);
	}
	return undefined;
}

function isAttachmentFilenameBoundary(source: string, start: number, end: number): boolean {
	const previous = Array.from(source.slice(0, start)).at(-1);
	const next = Array.from(source.slice(end))[0];
	return !isFilenameContinuation(previous) && !isFilenameContinuation(next);
}

function isFilenameContinuation(value: string | undefined): boolean {
	return value !== undefined && (/[\p{L}\p{M}\p{N}._-]/u.test(value) || value === "/" || value === "\\");
}

function isRangeAvailable(
	start: number,
	end: number,
	occupied: readonly { readonly start: number; readonly end: number }[],
): boolean {
	return !occupied.some((match) => start < match.end && end > match.start);
}

export function followUpText(item: FollowUp): string {
	return renderVisibleUserText(item.content);
}

export function recoverableStatus(card: RecoverablePromptCardView): string {
	return card.state === "failed" ? `Failed${card.failure ? `: ${card.failure}` : ""}` : "Paused";
}

export function renderStatusBorder(width: number, status: string): string {
	const safeStatus = sanitizeTerminalText(status).replace(/[\r\n]+/g, " ");
	if (displayWidth(safeStatus) + 3 > width) return clipAnsi(safeStatus, width);
	return `${"─".repeat(width - displayWidth(safeStatus) - 2)} ${safeStatus} `;
}

export function renderTimelineAttachments(
	attachments: readonly ChatAttachment[],
	width: number,
	blockId: string,
	focusedAttachmentKey: string | undefined,
	theme: TuiTheme,
	attachmentIndexes: readonly number[] = attachments.map((_, index) => index),
): { readonly lines: readonly string[]; readonly regions: readonly LocalAttachmentHitRegion[] } {
	if (attachments.length === 0) return { lines: [], regions: [] };
	const lines: string[] = [];
	const regions: LocalAttachmentHitRegion[] = [];
	let tokens: Array<{ readonly targetKey: string; readonly text: string; readonly width: number }> = [];
	const flush = (): void => {
		if (tokens.length === 0) return;
		let column = 0;
		const row = lines.length;
		lines.push(
			tokens
				.map((token) => {
					const start = column;
					column += token.width + 1;
					regions.push({ targetKey: token.targetKey, row, start, end: start + token.width });
					return token.text;
				})
				.join(" "),
		);
		tokens = [];
	};
	for (const [index, attachment] of attachments.entries()) {
		const targetKey = attachmentTargetKey(blockId, attachment.id, attachmentIndexes[index] ?? index);
		const focused = targetKey === focusedAttachmentKey;
		const label = clipAnsi(attachmentElementLabel(attachment.filename), width);
		const labelWidth = displayWidth(label);
		const used = tokens.reduce((total, token) => total + token.width, Math.max(0, tokens.length - 1));
		if (tokens.length > 0 && used + 1 + labelWidth > width) flush();
		tokens.push({ targetKey, text: focused ? theme.style("accent", label) : label, width: labelWidth });
	}
	flush();
	return { lines, regions };
}

export function attachmentTargetKey(owner: string, attachmentId: string, index: number): string {
	return `${owner}\u0000${attachmentId}\u0000${index}`;
}

export function shellActivation(input: TerminalInput): { readonly remainder?: TerminalInput } | undefined {
	if (input.type === "text" || input.type === "paste") {
		if (!input.text.startsWith("!")) return undefined;
		const remainder = input.text.slice(1);
		return remainder ? { remainder: { ...input, text: remainder } } : {};
	}
	if (
		input.type !== "key" ||
		input.action === "release" ||
		input.control ||
		input.alt ||
		input.meta ||
		!input.text?.startsWith("!")
	) {
		return undefined;
	}
	const remainder = input.text.slice(1);
	return remainder ? { remainder: { ...input, text: remainder } } : {};
}

export function renderHeader(width: number, transcriptMode: boolean): string {
	return clipAnsi(transcriptMode ? "Coda • Transcript" : "Coda", width);
}

export function renderTooSmall(width: number, height: number, running: boolean): string[] {
	const lines = [
		"Coda",
		"Terminal too small",
		`Resize to at least ${MINIMUM_CHAT_COLUMNS} x ${MINIMUM_CHAT_ROWS}`,
		"",
		running ? "Esc/Ctrl-C aborts" : "Ctrl-C twice exits",
	].map((line) => clipAnsi(line, width));
	return Array.from({ length: height }, (_, row) => lines[row] ?? "");
}

export function fitFooter(width: number, candidates: readonly string[]): string {
	const candidate = candidates.find((value) => displayWidth(value) <= width) ?? candidates.at(-1) ?? "";
	return clipAnsi(candidate, width);
}

export function actionFooter(width: number, candidates: readonly string[]): readonly [string, string] {
	return [fitFooter(width, candidates), ""];
}
