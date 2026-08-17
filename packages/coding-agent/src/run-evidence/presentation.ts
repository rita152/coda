import type { RunEvidenceEnvelope } from "./run-evidence.ts";

/** Renders an untrusted-text-free aggregate that packs into the available terminal width. */
export function renderRunEvidenceSummary(evidence: RunEvidenceEnvelope, width: number): readonly string[] {
	const inspected = evidence.paths.inspected.length + evidence.paths.omitted.inspected;
	const changed = evidence.paths.changed.length + evidence.paths.omitted.changed;
	const commands = evidence.commands.length + evidence.omitted.commands;
	const open = evidence.openFailures.length + evidence.omitted.openFailures;
	const recovered = evidence.recoveredFailures.length + evidence.omitted.recoveredFailures;
	const pending = evidence.pendingOperations.length + evidence.omitted.pendingOperations;
	const observationSegments = [
		evidence.observations.counts.windowed > 0 ? count(evidence.observations.counts.windowed, "windowed") : undefined,
		evidence.observations.counts["recoverable-overflow"] > 0
			? count(evidence.observations.counts["recoverable-overflow"], "recoverable overflow")
			: undefined,
		evidence.observations.counts["lossy-overflow"] > 0
			? count(evidence.observations.counts["lossy-overflow"], "lossy overflow")
			: undefined,
	].filter((segment): segment is string => segment !== undefined);
	const segments = [
		evidence.outcome === "success" ? "Evidence" : `Evidence (${evidence.outcome})`,
		count(inspected, "inspected"),
		count(changed, "changed"),
		count(commands, "command"),
		...observationSegments,
		...(recovered > 0 ? [count(recovered, "recovered failure")] : []),
		count(open, "open failure"),
		...(pending > 0 ? [count(pending, "pending operation")] : []),
		formatTokens(evidence.usage.totalTokens),
		formatCost(evidence),
		formatElapsed(evidence.elapsedMs),
	];
	return Object.freeze(packSegments(segments, Math.max(1, Math.floor(width))));
}

function count(value: number, label: string): string {
	return `${value} ${label}${value === 1 || label.endsWith("ed") ? "" : "s"}`;
}

function formatTokens(value: number): string {
	const tokens = Math.max(0, Math.floor(value));
	if (tokens < 1_000) return `${tokens} tokens`;
	if (tokens < 1_000_000) return `${compactNumber(tokens / 1_000)}k tokens`;
	return `${compactNumber(tokens / 1_000_000)}m tokens`;
}

function formatCost(evidence: RunEvidenceEnvelope): string {
	const { cost } = evidence.usage;
	if (cost.status === "unavailable") return "cost unavailable";
	const amount = cost.status === "complete" ? (cost.totalUsd ?? 0) : cost.knownTotalUsd;
	const digits = amount > 0 && amount < 0.01 ? 4 : 2;
	return `$${amount.toFixed(digits)}${cost.status === "partial" ? " known" : ""}`;
}

function formatElapsed(value: number): string {
	const milliseconds = Math.max(0, Math.floor(value));
	if (milliseconds < 1_000) return `${milliseconds}ms`;
	if (milliseconds < 60_000) return `${compactNumber(milliseconds / 1_000)}s`;
	const minutes = Math.floor(milliseconds / 60_000);
	const seconds = Math.floor((milliseconds % 60_000) / 1_000);
	return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

function compactNumber(value: number): string {
	return value >= 100 || Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1);
}

function packSegments(segments: readonly string[], width: number): string[] {
	const lines: string[] = [];
	let line = "";
	for (const segment of segments) {
		const candidate = line.length === 0 ? segment : `${line} · ${segment}`;
		if (Array.from(candidate).length <= width) {
			line = candidate;
			continue;
		}
		if (line.length > 0) lines.push(line);
		const chunks = splitSegment(segment, width);
		lines.push(...chunks.slice(0, -1));
		line = chunks.at(-1) ?? "";
	}
	if (line.length > 0) lines.push(line);
	return lines;
}

function splitSegment(value: string, width: number): string[] {
	const characters = Array.from(value);
	const chunks: string[] = [];
	for (let index = 0; index < characters.length; index += width) {
		chunks.push(characters.slice(index, index + width).join(""));
	}
	return chunks.length > 0 ? chunks : [""];
}
