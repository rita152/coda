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
import type { ChatAttachment } from "./chat-component.ts";
import type { TimelineEntry } from "./semantic-timeline.ts";
import type { TuiTheme } from "./theme.ts";
import { renderToolInvocation } from "./tool-presentation.ts";
import { renderUserShellEntry } from "./user-shell-presentation.ts";

export const MINIMUM_CHAT_COLUMNS = 40;
export const MINIMUM_CHAT_ROWS = 10;

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
	const width = Math.min(screenWidth, Math.max(Math.min(28, screenWidth), maximumWidth));
	const height = Math.min(availableHeight, Math.max(Math.min(8, availableHeight), maximumHeight));
	const row = 1 + Math.floor((availableHeight - height) / 2);
	const column = Math.floor((screenWidth - width) / 2);
	const innerWidth = Math.max(1, width - 2);
	const innerHeight = Math.max(1, height - 3);
	const sourceWidth = attachment.preview?.width ?? attachment.width;
	const sourceHeight = attachment.preview?.height ?? attachment.height;
	const widthFromHeight = Math.max(1, Math.floor((innerHeight * sourceWidth * 2) / Math.max(1, sourceHeight)));
	const imageWidth = Math.max(1, Math.min(innerWidth, widthFromHeight));
	const imageHeight = Math.max(1, Math.min(innerHeight, Math.ceil((imageWidth * sourceHeight) / (sourceWidth * 2))));
	return {
		row,
		column,
		width,
		height,
		imageRow: row + 1 + Math.floor((innerHeight - imageHeight) / 2),
		imageColumn: column + 1 + Math.floor((innerWidth - imageWidth) / 2),
		imageWidth,
		imageHeight,
		modal,
	};
}

export function renderPreviewOverlay(
	frame: readonly string[],
	geometry: PreviewGeometry,
	attachment: ChatAttachment,
	screenWidth: number,
): string[] {
	const title = geometry.modal ? ` Image preview • ${attachment.filename} ` : ` ${attachment.filename} `;
	const top = `┌${clipPlain(title, geometry.width - 2, "─")}┐`;
	const bottom = `└${"─".repeat(Math.max(0, geometry.width - 2))}┘`;
	const metadata = `${attachment.width}×${attachment.height} • ${attachment.mimeType} • ${formatBytes(attachment.bytes)}`;
	const box = Array.from({ length: geometry.height }, (_, index) => {
		if (index === 0) return top;
		if (index === geometry.height - 1) return bottom;
		if (index === geometry.height - 2) return `│${centerPlain(metadata, geometry.width - 2)}│`;
		return `│${" ".repeat(Math.max(0, geometry.width - 2))}│`;
	});
	return frame.map((line, row) => {
		const overlay = box[row - geometry.row];
		if (overlay === undefined) return line;
		const left = sliceAnsi(line, 0, geometry.column).padEnd(geometry.column);
		const rightStart = geometry.column + geometry.width;
		const right = sliceAnsi(line, rightStart, Math.max(0, screenWidth - rightStart));
		return clipAnsi(`${left}${overlay}${right}`, screenWidth);
	});
}

export function clipPlain(value: string, width: number, fill: string): string {
	const clipped = clipAnsi(sanitizeTerminalText(value).replace(/[\r\n]+/g, " "), Math.max(0, width));
	return `${clipped}${fill.repeat(Math.max(0, width - displayWidth(clipped)))}`;
}

export function centerPlain(value: string, width: number): string {
	const clipped = clipAnsi(sanitizeTerminalText(value), Math.max(0, width));
	const clippedWidth = displayWidth(clipped);
	const left = Math.max(0, Math.floor((width - clippedWidth) / 2));
	return `${" ".repeat(left)}${clipped}${" ".repeat(Math.max(0, width - left - clippedWidth))}`;
}

export function formatBytes(bytes: number): string {
	if (bytes < 1_024) return `${bytes} B`;
	if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KiB`;
	return `${(bytes / 1_048_576).toFixed(1)} MiB`;
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
	const lines = safeSource ? safeSource.split("\n").flatMap((line) => (line ? wrapAnsi(line, width) : [""])) : [];
	const border = theme.style("muted", "─".repeat(width));
	const bottom = status ? theme.style("muted", renderStatusBorder(width, status)) : border;
	const attachmentLayout = renderTimelineAttachments(attachments, width, blockId, focusedAttachmentKey, theme);
	return Object.freeze({
		lines: Object.freeze([border, ...attachmentLayout.lines, ...lines, bottom]),
		regions: Object.freeze(
			attachmentLayout.regions.map((region) => Object.freeze({ ...region, row: region.row + 1 })),
		),
	});
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
		const targetKey = attachmentTargetKey(blockId, attachment.id, index);
		const focused = targetKey === focusedAttachmentKey;
		const label = clipAnsi(
			`${focused ? "›" : ""}[${sanitizeTerminalText(attachment.filename).replace(/[\r\n]+/g, " ")}]`,
			width,
		);
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
