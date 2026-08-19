import { clipAnsi, displayWidth, sanitizeTerminalText, wrapAnsi } from "@coda/tui";
import { mutationRequestMetadata } from "../tools/mutation-contract.ts";
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

export interface ToolActionInvocation {
	readonly toolName: string;
	readonly arguments: Readonly<Record<string, unknown>>;
}

const MAIN_PREVIEW_ROWS = 5;
const EXPLORATION_TOOLS = new Set(["read", "grep", "find", "ls", "web_search", "fetch"]);

// Main-Timeline geometry follows OpenAI Codex f93109615ff2. Coda retains its own Tool lifecycle,
// ordering, and Transcript View semantics rather than translating Codex's scrollback cells.

export function isExplorationTool(entry: TimelineToolEntry): boolean {
	return EXPLORATION_TOOLS.has(entry.invocation.toolName);
}

export function renderExplorationGroup(
	entries: readonly TimelineToolEntry[],
	options: ToolRenderOptions,
): readonly string[] {
	if (entries.length === 0) return [];
	const active = entries.some((entry) => entry.state === "running");
	const failed = entries.some((entry) => entry.state !== "running" && entry.state !== "success");
	const glyph = active ? styledStatusGlyph("running", options) : options.theme.style(failed ? "error" : "muted", "•");
	const title = options.theme.style("strong", active ? "Exploring" : "Explored");
	const lines = prefixedWrap(title, options.width, `${glyph} `, options.theme.style("muted", "  │ "));
	const detailWidth = Math.max(1, options.width - 4);
	const details = entries.flatMap((entry) => renderExplorationDetail(entry, detailWidth, options.theme));
	lines.push(
		...details.map((line, index) =>
			clipAnsi(`${index === 0 ? options.theme.style("muted", "  └ ") : "    "}${line}`, options.width),
		),
	);
	return lines;
}

export function renderToolInvocation(entry: TimelineToolEntry, options: ToolRenderOptions): readonly string[] {
	if (!Number.isSafeInteger(options.width) || options.width < 1) {
		throw new RangeError("Tool presentation width must be a positive integer");
	}
	const bullet = styledStatusGlyph(entry.state, options);
	const duration = durationSuffix(entry, options.now);
	const title = options.transcript
		? `${statusTitle(entry)}${duration}`
		: `${styledStatusTitle(entry, options.theme)}${duration ? options.theme.style("muted", duration) : ""}`;
	const titleLines = prefixedWrap(
		title,
		options.width,
		`${bullet} `,
		options.transcript ? "  │ " : options.theme.style("muted", "  │ "),
	);
	const detailWidth = Math.max(1, options.width - 4);
	const delegated = renderDelegatedChildren(entry, detailWidth, options);
	let details = renderDetails(entry, detailWidth, options);
	if (!options.transcript) {
		if (details.length === 0 && entry.invocation.toolName === "bash" && entry.result && entry.state !== "running") {
			details = ["(no output)"];
		}
		details = truncatePreview(details, detailWidth);
		if (entry.invocation.toolName !== "edit") {
			details = details.map((line) => options.theme.style("muted", line));
		}
	}
	const body = [...delegated, ...details];
	if (body.length === 0) return titleLines;
	return [
		...titleLines,
		...body.map((line, index) =>
			clipAnsi(
				`${index === 0 && !options.transcript ? options.theme.style("muted", "  └ ") : index === 0 ? "  └ " : "    "}${line}`,
				options.width,
			),
		),
	];
}

function renderDelegatedChildren(entry: TimelineToolEntry, width: number, options: ToolRenderOptions): string[] {
	if (!entry.delegated || entry.delegated.length === 0) return [];
	const lines: string[] = [];
	for (const child of entry.delegated) {
		const tool = child.currentTool ? ` · ${child.currentTool.name}` : "";
		const result =
			child.result === undefined
				? ""
				: ` · ${child.result.state} · ${child.result.publication}${
						child.result.diagnostics[0] ? ` · ${child.result.diagnostics[0].code}` : ""
					}`;
		lines.push(...wrapAnsi(`${child.executionMode} · ${child.objective} · ${child.state}${tool}${result}`, width));
		if (options.transcript) {
			for (const toolEntry of child.tools) {
				const nested = renderToolInvocation(toolEntry, { ...options, width: Math.max(1, width - 2) });
				lines.push(...nested.map((line) => `  ${line}`));
			}
		}
	}
	return options.transcript ? lines : lines.map((line) => options.theme.style("muted", line));
}

function styledStatusTitle(entry: TimelineToolEntry, theme: TuiTheme): string {
	const present = actionParts(entry.invocation, false);
	const past = actionParts(entry.invocation, true);
	const action = (parts: ToolActionParts) => {
		const subject = parts.code ? theme.style("code", parts.subject) : parts.subject;
		return `${theme.style("strong", parts.verb)}${subject ? ` ${subject}` : ""}`;
	};
	switch (entry.state) {
		case "running":
			return action(present);
		case "success":
			return action(past);
		case "failed":
			return `${action(past)} ${theme.style("error", "— failed")}`;
		case "aborted":
			return `${theme.style("strong", "Aborted")} — ${action(present)}`;
		case "skipped":
			return `${theme.style("strong", "Skipped")} — ${action(present)}`;
		case "interrupted":
			return `${theme.style("strong", "Interrupted")} — ${action(present)}; side effects unknown`;
	}
}

interface ToolActionParts {
	readonly verb: string;
	readonly subject: string;
	readonly code?: boolean;
}

function actionParts(invocation: ToolActionInvocation, completed: boolean): ToolActionParts {
	const { arguments: arguments_, toolName } = invocation;
	const mutation = safeMutationMetadata(invocation);
	if (mutation) {
		return { verb: completed ? mutation.pastVerb : mutation.presentVerb, subject: mutation.subject };
	}
	const path = argumentString(arguments_, "path", ".");
	switch (toolName) {
		case "read":
			return { verb: completed ? "Read" : "Reading", subject: path };
		case "grep": {
			const pattern = argumentString(arguments_, "pattern", "");
			return { verb: completed ? "Searched" : "Searching", subject: `“${pattern}” in ${path}` };
		}
		case "find": {
			const pattern = argumentString(arguments_, "pattern", "*");
			return { verb: completed ? "Explored" : "Exploring", subject: `${pattern} in ${path}` };
		}
		case "ls":
			return { verb: completed ? "Explored" : "Exploring", subject: path };
		case "web_search": {
			const query = argumentString(arguments_, "query", "");
			return { verb: completed ? "Searched" : "Searching", subject: `“${query}” on the web` };
		}
		case "fetch":
			return {
				verb: completed ? "Fetched" : "Fetching",
				subject: argumentString(arguments_, "url", "(missing URL)"),
			};
		case "bash":
			return {
				verb: completed ? "Ran" : "Running",
				subject: sanitizeInline(argumentString(arguments_, "command", "(empty command)")),
				code: true,
			};
		case "process":
			return processActionParts(arguments_, completed);
		case "delegate":
			return { verb: completed ? "Delegated" : "Delegating", subject: "child Work Items" };
		default: {
			const name = sanitizeInline(toolName);
			const argumentsSummary = compactArguments(arguments_);
			return {
				verb: completed ? "Called" : "Calling",
				subject: `${name}${argumentsSummary ? ` ${argumentsSummary}` : ""}`,
			};
		}
	}
}

function renderExplorationDetail(entry: TimelineToolEntry, width: number, theme: TuiTheme): string[] {
	const { arguments: arguments_, toolName } = entry.invocation;
	const path = argumentString(arguments_, "path", ".");
	let verb: string;
	let subject: string;
	switch (toolName) {
		case "read":
			verb = "Read";
			subject = path;
			break;
		case "grep": {
			verb = "Search";
			const pattern = argumentString(arguments_, "pattern", "");
			subject = `${pattern}${theme.style("muted", " in ")}${path}`;
			break;
		}
		case "find": {
			verb = "List";
			const pattern = argumentString(arguments_, "pattern", "*");
			subject = `${pattern}${theme.style("muted", " in ")}${path}`;
			break;
		}
		case "ls":
			verb = "List";
			subject = path;
			break;
		case "web_search":
			verb = "Search";
			subject = `${argumentString(arguments_, "query", "")}${theme.style("muted", " on the web")}`;
			break;
		case "fetch":
			verb = "Fetch";
			subject = argumentString(arguments_, "url", "(missing URL)");
			break;
		default:
			verb = "Run";
			subject = sanitizeInline(toolName);
	}
	const suffix = childStateSuffix(entry.state);
	const suffixTone: ThemeTone = entry.state === "failed" ? "error" : "warning";
	const styledSuffix = suffix ? theme.style(suffixTone, suffix) : "";
	const prefix = `${theme.style("accent", verb)} `;
	const prefixWidth = displayWidth(prefix);
	const wrapped = wrapAnsi(`${subject}${styledSuffix}`, Math.max(1, width - prefixWidth));
	return wrapped.map((line, index) => `${index === 0 ? prefix : " ".repeat(prefixWidth)}${line}`);
}

function statusTitle(entry: TimelineToolEntry): string {
	const present = toolActionTitle(entry.invocation, false);
	const past = toolActionTitle(entry.invocation, true);
	switch (entry.state) {
		case "running":
			return present;
		case "success":
			return past;
		case "failed":
			return `${past} — failed`;
		case "aborted":
			return `Aborted — ${present}`;
		case "skipped":
			return `Skipped — ${present}`;
		case "interrupted":
			return `Interrupted — ${present}; side effects unknown`;
	}
}

/** A bounded caller can reuse the same present/past action language outside the Timeline. */
export function toolActionTitle(invocation: ToolActionInvocation, completed = false): string {
	const { arguments: arguments_, toolName } = invocation;
	const mutation = safeMutationMetadata(invocation);
	if (mutation) return `${completed ? mutation.pastVerb : mutation.presentVerb} ${mutation.subject}`;
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
		case "web_search": {
			const query = argumentString(arguments_, "query", "");
			return `${completed ? "Searched" : "Searching"} “${query}” on the web`;
		}
		case "fetch": {
			const url = argumentString(arguments_, "url", "(missing URL)");
			return `${completed ? "Fetched" : "Fetching"} ${url}`;
		}
		case "process": {
			const parts = processActionParts(arguments_, completed);
			return `${parts.verb} ${parts.subject}`;
		}
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
	const progress = progressDetails(entry, width);
	if (entry.invocation.toolName === "edit") {
		return [...progress, ...renderDiff(entry, width, options.theme)];
	}
	if (entry.invocation.toolName === "read" && !options.transcript && details) {
		const start = numberField(details, "startLine");
		const end = numberField(details, "endLine");
		const total = numberField(details, "totalLines");
		if (start !== undefined && end !== undefined && total !== undefined) {
			const truncated = details.truncated === true ? " • truncated" : "";
			return [...progress, ...wrapDetail(`${start}–${end} of ${total} lines${truncated}`, width)];
		}
	}
	if (entry.invocation.toolName === "write" && details) {
		const operation = stringField(details, "operation");
		const bytes = numberField(details, "bytes");
		if (operation || bytes !== undefined) {
			return [
				...progress,
				...wrapDetail(`${operation ?? "write"}${bytes === undefined ? "" : ` • ${bytes} bytes`}`, width),
			];
		}
	}

	const lines = [...progress, ...normalizedResultLines(entry, width, options.toolResultImagesSupported ?? false)];
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

function progressDetails(entry: TimelineToolEntry, width: number): string[] {
	const progress = entry.progress;
	if (!progress) return [];
	const message = progress.message ? sanitizeInline(progress.message).slice(0, 512) : "";
	const value = Number.isFinite(progress.progress) ? progress.progress : undefined;
	const total = progress.total !== undefined && Number.isFinite(progress.total) ? progress.total : undefined;
	let measurement = "";
	if (value !== undefined && total !== undefined) {
		const ratio = `${value}/${total}`;
		const percentage = total === 0 ? undefined : (value / total) * 100;
		measurement = Number.isFinite(percentage) ? `${Math.round(percentage!)}% (${ratio})` : ratio;
	} else if (value !== undefined) {
		measurement = String(value);
	}
	const summary = [message, measurement].filter(Boolean).join(" • ");
	return summary ? wrapDetail(`Progress: ${summary}`, width) : [];
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

function safeMutationMetadata(invocation: ToolActionInvocation) {
	try {
		return mutationRequestMetadata(invocation.toolName, invocation.arguments);
	} catch {
		return undefined;
	}
}

function processActionParts(arguments_: Readonly<Record<string, unknown>>, completed: boolean): ToolActionParts {
	const action = argumentString(arguments_, "action", "");
	const processId = argumentString(arguments_, "processId", "");
	switch (action) {
		case "start":
			return {
				verb: completed ? "Started" : "Starting",
				subject: sanitizeInline(argumentString(arguments_, "command", "(empty command)")),
				code: true,
			};
		case "poll":
			return { verb: completed ? "Polled" : "Polling", subject: processId || "process" };
		case "write":
			return { verb: completed ? "Wrote to" : "Writing to", subject: processId || "process" };
		case "stop":
			return { verb: completed ? "Stopped" : "Stopping", subject: processId || "process" };
		default:
			return { verb: completed ? "Called" : "Calling", subject: "process" };
	}
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
		clipAnsi(`… +${hidden} lines (ctrl + t to view transcript)`, width),
		lines.at(-2) ?? "",
		lines.at(-1) ?? "",
	];
}

function prefixedWrap(value: string, width: number, firstPrefix: string, continuationPrefix: string): string[] {
	const contentWidth = Math.max(1, width - Math.max(displayWidth(firstPrefix), displayWidth(continuationPrefix)));
	const wrapped = wrapAnsi(value, contentWidth);
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
		case "aborted":
		case "skipped":
		case "interrupted":
			return "!";
		default:
			return "•";
	}
}

function styledStatusGlyph(state: TimelineToolState, options: ToolRenderOptions): string {
	if (state !== "running") {
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
