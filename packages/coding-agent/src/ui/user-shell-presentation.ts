import { clipAnsi, sanitizeTerminalText, wrapAnsi } from "@coda/tui";
import type { TimelineUserShellEntry } from "./semantic-timeline.ts";
import type { ThemeTone, TuiTheme } from "./theme.ts";

export function renderUserShellEntry(
	entry: TimelineUserShellEntry,
	options: { readonly width: number; readonly now: number; readonly theme: TuiTheme },
): readonly string[] {
	const tone = shellTone(entry);
	const glyph = options.theme.style(tone, "•");
	const title = `${shellTitle(entry)}${durationSuffix(entry, options.now)}`;
	const titleLines = prefixed(title, options.width, `${glyph} `, "  │ ");
	const logicalOutput = entry.output
		? entry.output.split("\n")
		: entry.status === "running"
			? []
			: [entry.error ?? "(no output)"];
	if (entry.error && entry.output) logicalOutput.push(entry.error);
	if (logicalOutput.length === 0) return titleLines;
	const detailWidth = Math.max(1, options.width - 4);
	const details = logicalOutput.flatMap((line) =>
		wrapAnsi(options.theme.style("muted", sanitizeTerminalText(line)), detailWidth),
	);
	return [
		...titleLines,
		...details.map((line, index) => clipAnsi(`${index === 0 ? "  └ " : "    "}${line}`, options.width)),
	];
}

function shellTitle(entry: TimelineUserShellEntry): string {
	const command = sanitizeTerminalText(entry.command).replace(/[\r\n]+/g, " ");
	switch (entry.status) {
		case "running":
			return `Running ${command}`;
		case "success":
			return `You ran ${command}`;
		case "failed": {
			const detail =
				entry.exitCode !== undefined && entry.exitCode !== null && entry.exitCode !== 0
					? `exit ${entry.exitCode}`
					: entry.signal
						? `signal ${entry.signal}`
						: undefined;
			return `You ran ${command} — failed${detail ? ` (${detail})` : ""}`;
		}
		case "timed_out":
			return `You ran ${command} — timed out`;
		case "cancelled":
			return `Cancelled — Running ${command}`;
		case "unsupported":
			return `Could not run ${command}`;
	}
}

function shellTone(entry: TimelineUserShellEntry): ThemeTone {
	if (entry.status === "success") return "success";
	if (entry.status === "failed" || entry.status === "timed_out" || entry.status === "unsupported") return "error";
	if (entry.status === "cancelled") return "warning";
	return "muted";
}

function prefixed(value: string, width: number, first: string, continuation: string): string[] {
	const contentWidth = Math.max(1, width - 4);
	return wrapAnsi(sanitizeTerminalText(value), contentWidth).map((line, index) =>
		clipAnsi(`${index === 0 ? first : continuation}${line}`, width),
	);
}

function durationSuffix(entry: TimelineUserShellEntry, now: number): string {
	const duration = entry.durationMs ?? Math.max(0, now - entry.startedAt);
	if (duration < 1_000) return "";
	if (duration < 10_000) return ` (${(duration / 1_000).toFixed(1)}s)`;
	if (duration < 60_000) return ` (${Math.round(duration / 1_000)}s)`;
	const minutes = Math.floor(duration / 60_000);
	const seconds = Math.round((duration % 60_000) / 1_000);
	return ` (${minutes}m ${seconds}s)`;
}
