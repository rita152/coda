import { clipAnsi, displayWidth, sanitizeTerminalText, wrapAnsi } from "@coda/tui";
import type { TimelineToolEntry, TimelineToolState } from "./semantic-timeline.ts";
import type { ThemeTone, TuiTheme } from "./theme.ts";

export interface ToolRenderOptions {
	readonly width: number;
	readonly now: number;
	readonly transcript: boolean;
	readonly theme: TuiTheme;
	readonly motion?: "full" | "reduced";
	readonly toolResultImagesSupported?: boolean;
}

const MAIN_PREVIEW_ROWS = 5;
const EXPLORATION_TOOLS = new Set(["read", "grep", "find", "ls"]);

export function isExplorationTool(entry: TimelineToolEntry): boolean {
	return EXPLORATION_TOOLS.has(entry.invocation.toolName);
}

export function renderExplorationGroup(
	entries: readonly TimelineToolEntry[],
	options: ToolRenderOptions,
): readonly string[] {
	if (entries.length === 0) return [];
	const active = entries.some((entry) => entry.state === "running" || entry.state === "awaiting_approval");
	const failures = entries.filter((entry) => entry.state !== "running" && entry.state !== "success").length;
	const aggregateState: TimelineToolState = active ? "running" : failures > 0 ? "failed" : "success";
	const glyph = styledStatusGlyph(aggregateState, options);
	const title = `${active ? "Exploring" : "Explored"}${failures > 0 ? ` — ${failures} issue${failures === 1 ? "" : "s"}` : ""}`;
	const lines = prefixedWrap(title, options.width, `${glyph} `, "  │ ");
	for (const [index, entry] of entries.entries()) {
		const terminal = entry.state !== "running" && entry.state !== "awaiting_approval";
		const suffix = childStateSuffix(entry.state);
		const branch = index === entries.length - 1 ? "  └ " : "  ├ ";
		lines.push(
			...prefixedWrap(
				`${actionTitle(entry, terminal)}${suffix}`,
				options.width,
				options.theme.style(entry.state === "failed" ? "error" : "accent", branch),
				"  │ ",
			),
		);
	}
	return lines;
}

export function renderToolInvocation(entry: TimelineToolEntry, options: ToolRenderOptions): readonly string[] {
	if (!Number.isSafeInteger(options.width) || options.width < 1) {
		throw new RangeError("Tool presentation width must be a positive integer");
	}
	const bullet = styledStatusGlyph(entry.state, options);
	const title = `${statusTitle(entry)}${durationSuffix(entry, options.now)}`;
	const titleLines = prefixedWrap(title, options.width, `${bullet} `, "  │ ");
	const detailWidth = Math.max(1, options.width - 4);
	let details = renderDetails(entry, detailWidth, options);
	if (!options.transcript) details = truncatePreview(details, detailWidth);
	if (details.length === 0) return titleLines;
	return [
		...titleLines,
		...details.map((line, index) => clipAnsi(`${index === 0 ? "  └ " : "    "}${line}`, options.width)),
	];
}

function statusTitle(entry: TimelineToolEntry): string {
	const present = actionTitle(entry, false);
	const past = actionTitle(entry, true);
	switch (entry.state) {
		case "awaiting_approval":
			return `Awaiting approval — ${present}`;
		case "running":
			return present;
		case "success":
			return past;
		case "failed":
			return `${past} — failed`;
		case "denied":
			return `Denied — ${present}`;
		case "aborted":
			return `Aborted — ${present}`;
		case "skipped":
			return `Skipped — ${present}`;
		case "interrupted":
			return `Interrupted — ${present}; side effects unknown`;
	}
}

function actionTitle(entry: TimelineToolEntry, completed: boolean): string {
	const { arguments: arguments_, toolName } = entry.invocation;
	const path = argumentString(arguments_, "path", ".");
	switch (toolName) {
		case "read":
			return `${completed ? "Read" : "Reading"} ${path}`;
		case "grep": {
			const pattern = argumentString(arguments_, "pattern", "");
			return `${completed ? "Searched" : "Searching"} “${pattern}” in ${path}`;
		}
		case "find": {
			const pattern = argumentString(arguments_, "pattern", "*");
			return `${completed ? "Explored" : "Exploring"} ${pattern} in ${path}`;
		}
		case "ls":
			return `${completed ? "Explored" : "Exploring"} ${path}`;
		case "edit":
			return `${completed ? "Edited" : "Editing"} ${path}`;
		case "write":
			return `${completed ? "Wrote" : "Writing"} ${path}`;
		case "bash": {
			const command = argumentString(arguments_, "command", "(empty command)");
			return `${completed ? "Ran" : "Running"} ${command}`;
		}
		default: {
			const name = sanitizeInline(toolName);
			const argumentsSummary = compactArguments(arguments_);
			return `${completed ? "Called" : "Calling"} ${name}${argumentsSummary ? ` ${argumentsSummary}` : ""}`;
		}
	}
}

function renderDetails(entry: TimelineToolEntry, width: number, options: ToolRenderOptions): string[] {
	const details = record(entry.result?.message.details);
	if (entry.invocation.toolName === "edit") {
		return renderDiff(entry, width, options.theme);
	}
	if (entry.invocation.toolName === "read" && !options.transcript && details) {
		const start = numberField(details, "startLine");
		const end = numberField(details, "endLine");
		const total = numberField(details, "totalLines");
		if (start !== undefined && end !== undefined && total !== undefined) {
			const truncated = details.truncated === true ? " • truncated" : "";
			return wrapDetail(`${start}–${end} of ${total} lines${truncated}`, width);
		}
	}
	if (entry.invocation.toolName === "write" && details) {
		const operation = stringField(details, "operation");
		const bytes = numberField(details, "bytes");
		if (operation || bytes !== undefined) {
			return wrapDetail(`${operation ?? "write"}${bytes === undefined ? "" : ` • ${bytes} bytes`}`, width);
		}
	}

	const lines = normalizedResultLines(entry, width, options.toolResultImagesSupported ?? false);
	if (entry.invocation.toolName === "bash" && details) {
		const metadata = bashMetadata(details);
		for (const value of metadata) lines.push(...wrapDetail(value, width));
	} else if (
		(entry.invocation.toolName === "grep" ||
			entry.invocation.toolName === "find" ||
			entry.invocation.toolName === "ls") &&
		details
	) {
		const count = numberField(details, "count");
		if (count !== undefined || details.truncated === true) {
			lines.push(
				...wrapDetail(
					`${count === undefined ? "" : `${count} result${count === 1 ? "" : "s"}`}${details.truncated === true ? `${count === undefined ? "" : " • "}truncated` : ""}`,
					width,
				),
			);
		}
	}
	return lines;
}

function normalizedResultLines(entry: TimelineToolEntry, width: number, toolResultImagesSupported: boolean): string[] {
	const content = entry.result?.message.content ?? [];
	let imageIndex = 0;
	const text = content
		.map((block) => {
			if (block.type === "text") return block.text;
			imageIndex++;
			const filename = `${sanitizeInline(entry.invocation.toolName) || "tool"}-image-${imageIndex}.${imageExtension(block.mimeType)}`;
			return `[${filename}]${toolResultImagesSupported ? "" : " — previewable here; selected Provider sends a text placeholder"}`;
		})
		.join("\n");
	if (!text) return [];
	return sanitizeTerminalText(text)
		.split("\n")
		.flatMap((line) => (line ? wrapAnsi(line, width) : [""]));
}

function imageExtension(mimeType: string): string {
	switch (mimeType.toLowerCase()) {
		case "image/jpeg":
			return "jpg";
		case "image/gif":
			return "gif";
		case "image/webp":
			return "webp";
		default:
			return "png";
	}
}

function renderDiff(entry: TimelineToolEntry, width: number, theme: TuiTheme): string[] {
	const path = argumentString(entry.invocation.arguments, "path", "file");
	const before = argumentText(entry.invocation.arguments, "oldText", "");
	const after = argumentText(entry.invocation.arguments, "newText", "");
	const logical = [
		`--- ${path}`,
		`+++ ${path}`,
		"@@ exact replacement @@",
		...before.split("\n").map((line) => `-${line}`),
		...after.split("\n").map((line) => `+${line}`),
	];
	return logical.flatMap((line) => {
		const tone: ThemeTone = line.startsWith("+++")
			? "success"
			: line.startsWith("---")
				? "error"
				: line.startsWith("+")
					? "success"
					: line.startsWith("-")
						? "error"
						: "muted";
		return wrapAnsi(theme.style(tone, line), width);
	});
}

function bashMetadata(details: Record<string, unknown>): string[] {
	const lines: string[] = [];
	const exitCode = numberField(details, "exitCode");
	const signal = stringField(details, "signal");
	if (details.timedOut === true) lines.push("timed out");
	if (signal) lines.push(`signal ${signal}`);
	if (exitCode !== undefined && exitCode !== 0) lines.push(`exit ${exitCode}`);
	if (details.truncated === true) lines.push("output truncated");
	return lines;
}

function truncatePreview(lines: readonly string[], width: number): string[] {
	if (lines.length <= MAIN_PREVIEW_ROWS) return [...lines];
	const hidden = lines.length - 4;
	return [
		lines[0] ?? "",
		lines[1] ?? "",
		clipAnsi(`… +${hidden} lines (Ctrl+T for transcript)`, width),
		lines.at(-2) ?? "",
		lines.at(-1) ?? "",
	];
}

function prefixedWrap(value: string, width: number, firstPrefix: string, continuationPrefix: string): string[] {
	const contentWidth = Math.max(1, width - Math.max(displayWidth(firstPrefix), displayWidth(continuationPrefix)));
	const wrapped = wrapAnsi(sanitizeTerminalText(value), contentWidth);
	return wrapped.map((line, index) => clipAnsi(`${index === 0 ? firstPrefix : continuationPrefix}${line}`, width));
}

function durationSuffix(entry: TimelineToolEntry, now: number): string {
	if (entry.startedAt === undefined) return "";
	const end = entry.endedAt ?? now;
	const duration = Math.max(0, end - entry.startedAt);
	if (duration < 1_000) return "";
	return ` (${formatDuration(duration)})`;
}

function formatDuration(durationMs: number): string {
	if (durationMs < 10_000) return `${(durationMs / 1_000).toFixed(1)}s`;
	if (durationMs < 60_000) return `${Math.round(durationMs / 1_000)}s`;
	const minutes = Math.floor(durationMs / 60_000);
	const seconds = Math.round((durationMs % 60_000) / 1_000);
	return `${minutes}m ${seconds}s`;
}

function statusGlyph(state: TimelineToolState, transcript: boolean): string {
	if (!transcript) return "•";
	switch (state) {
		case "success":
			return "✓";
		case "failed":
			return "✗";
		case "denied":
		case "aborted":
		case "skipped":
		case "interrupted":
			return "!";
		default:
			return "•";
	}
}

function styledStatusGlyph(state: TimelineToolState, options: ToolRenderOptions): string {
	if (state !== "running" && state !== "awaiting_approval") {
		return options.theme.style(stateTone(state), statusGlyph(state, options.transcript));
	}
	if ((options.motion ?? "reduced") === "reduced") return options.theme.style("muted", "•");
	if (options.theme.colorLevel === 3) {
		const phase = Math.floor(options.now / 80) % 8;
		const brightness = [110, 135, 165, 205, 235, 205, 165, 135][phase] ?? 165;
		return `\x1b[38;2;40;${brightness};${Math.min(255, brightness + 20)}m•\x1b[0m`;
	}
	const glyph = Math.floor(options.now / 600) % 2 === 0 ? "•" : "◦";
	return options.theme.style("accent", glyph);
}

function stateTone(state: TimelineToolState): ThemeTone {
	switch (state) {
		case "success":
			return "success";
		case "failed":
			return "error";
		case "denied":
		case "aborted":
		case "skipped":
		case "interrupted":
			return "warning";
		default:
			return "accent";
	}
}

function childStateSuffix(state: TimelineToolState): string {
	switch (state) {
		case "failed":
			return " — failed";
		case "denied":
			return " — denied";
		case "aborted":
			return " — aborted";
		case "skipped":
			return " — skipped";
		case "interrupted":
			return " — interrupted";
		default:
			return "";
	}
}

function argumentString(arguments_: Readonly<Record<string, unknown>>, key: string, fallback: string): string {
	const value = arguments_[key];
	return typeof value === "string" ? sanitizeInline(value) : fallback;
}

function argumentText(arguments_: Readonly<Record<string, unknown>>, key: string, fallback: string): string {
	const value = arguments_[key];
	return typeof value === "string" ? sanitizeTerminalText(value) : fallback;
}

function compactArguments(arguments_: Readonly<Record<string, unknown>>): string {
	try {
		return sanitizeInline(JSON.stringify(arguments_));
	} catch {
		return "{…}";
	}
}

function sanitizeInline(value: string): string {
	return sanitizeTerminalText(value)
		.replace(/[\r\n\t]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function wrapDetail(value: string, width: number): string[] {
	return value ? wrapAnsi(sanitizeTerminalText(value), width) : [];
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function numberField(value: Record<string, unknown>, key: string): number | undefined {
	return typeof value[key] === "number" && Number.isFinite(value[key]) ? (value[key] as number) : undefined;
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
	return typeof value[key] === "string" ? sanitizeInline(value[key] as string) : undefined;
}
