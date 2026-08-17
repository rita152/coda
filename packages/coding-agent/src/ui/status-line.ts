import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { clipAnsi, displayWidth, sanitizeTerminalText, sliceAnsi } from "@coda/tui";
import { type PermissionsCommandState, permissionStatusLabel } from "../commands/permissions-flow.ts";
import type { ThemeTone, TuiTheme } from "./theme.ts";

export interface GitStatusSnapshot {
	readonly branch?: string;
	readonly detachedHead?: string;
	readonly dirty: boolean;
}

export interface StatusLineContextSnapshot {
	readonly usedTokens: number;
	readonly windowTokens: number;
	readonly estimated: boolean;
}

export interface StatusLineCostSnapshot {
	readonly usd?: number;
	readonly subscription?: boolean;
}

export interface SessionStatusLineSnapshot {
	readonly modelSupportsReasoning: boolean;
	readonly context: StatusLineContextSnapshot;
	readonly cost?: StatusLineCostSnapshot;
}

export interface StatusLineSnapshot extends SessionStatusLineSnapshot {
	readonly workspacePath: string;
	readonly homePath?: string;
	readonly git?: GitStatusSnapshot;
	readonly permissions?: PermissionsCommandState;
}

export interface StatusLinePresentation {
	readonly modelLabel: string;
	readonly reasoning: string;
}

interface RenderedText {
	readonly plain: string;
	readonly styled: string;
}

interface StatusRow {
	readonly left?: RenderedText;
	readonly right?: RenderedText;
}

export function renderStatusLine(
	snapshot: StatusLineSnapshot,
	presentation: StatusLinePresentation,
	width: number,
	theme: TuiTheme,
): readonly [string, string] {
	const safeWidth = Math.max(0, width);
	const first = renderStatusRow(selectWorkspaceRow(snapshot, safeWidth, theme), safeWidth);
	const second = renderStatusRow(selectUsageRow(snapshot, presentation, safeWidth, theme), safeWidth);
	return [first, second];
}

export function formatStatusLineTokens(tokens: number): string {
	const value = Math.max(0, Math.round(tokens));
	if (value < 1_000) return String(value);
	if (value < 10_000) return `${trimDecimal((value / 1_000).toFixed(1))}k`;
	if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
	if (value < 10_000_000) return `${trimDecimal((value / 1_000_000).toFixed(1))}m`;
	return `${Math.round(value / 1_000_000)}m`;
}

export function formatStatusLineCost(cost: StatusLineCostSnapshot): string | undefined {
	const usd = cost.usd;
	const dollar = usd === undefined ? undefined : formatUsd(usd);
	if (cost.subscription) return dollar && usd !== 0 ? `${dollar}+sub` : "sub";
	return dollar;
}

function selectWorkspaceRow(snapshot: StatusLineSnapshot, width: number, theme: TuiTheme): StatusRow {
	const paths = workspacePathCandidates(snapshot.workspacePath, snapshot.homePath).map((value) =>
		styled(theme, "muted", value),
	);
	const branch = gitPresentation(snapshot.git, theme);
	const permission = permissionPresentation(snapshot.permissions, theme);
	const withBranch = paths.map((path) => joinRendered([path, branch], " "));

	for (const left of withBranch) {
		if (fits(left, permission, width)) return { left, right: permission };
	}
	for (const path of paths) {
		if (fits(path, permission, width)) return { left: path, right: permission };
	}
	if (permission && fits(undefined, permission, width)) {
		const shortest = paths.at(-1);
		const reserved = displayWidth(permission.plain) + 2;
		if (shortest && width - reserved > 1) {
			return { left: truncateRendered(shortest, width - reserved, theme, "muted"), right: permission };
		}
		return { right: permission };
	}
	if (branch) {
		for (const path of [...paths].reverse()) {
			if (fits(path, undefined, width)) return { left: path };
		}
	}
	const compact = withBranch.at(-1) ?? paths.at(-1);
	return compact ? { left: truncateRendered(compact, width, theme, "muted") } : {};
}

function permissionPresentation(
	permissions: PermissionsCommandState | undefined,
	theme: TuiTheme,
): RenderedText | undefined {
	if (!permissions) return undefined;
	const label = permissionStatusLabel(permissions);
	return styled(theme, permissionTone(label), label);
}

function permissionTone(label: string): ThemeTone {
	return label === "Full Access" || label.includes("Full Access") || label.includes("Untrusted") ? "warning" : "muted";
}

function selectUsageRow(
	snapshot: StatusLineSnapshot,
	presentation: StatusLinePresentation,
	width: number,
	theme: TuiTheme,
): StatusRow {
	const context = contextPresentation(snapshot.context, theme);
	const costValue = snapshot.cost ? formatStatusLineCost(snapshot.cost) : undefined;
	const cost = costValue ? styled(theme, "muted", costValue) : undefined;
	const costAndContext = joinRendered([cost, context], " · ", theme);
	const model = modelPresentations(presentation, snapshot.modelSupportsReasoning, theme);
	const candidates: readonly StatusRow[] = [
		{ left: costAndContext, right: model.full },
		{ left: context, right: model.full },
		{ left: context, right: model.withoutProvider },
	];
	for (const candidate of candidates) {
		if (fits(candidate.left, candidate.right, width)) return candidate;
	}

	const availableForModel = width - displayWidth(context.plain) - 2;
	if (availableForModel > 1) {
		return {
			left: context,
			right: model.truncate(availableForModel),
		};
	}
	return { right: model.truncate(width) };
}

function renderStatusRow(row: StatusRow, width: number): string {
	if (width <= 0) return "";
	if (!row.left && !row.right) return "";
	if (!row.left) {
		const right = row.right!;
		return clipAnsi(`${" ".repeat(Math.max(0, width - displayWidth(right.plain)))}${right.styled}`, width);
	}
	if (!row.right) return clipAnsi(row.left.styled, width);
	const padding = Math.max(2, width - displayWidth(row.left.plain) - displayWidth(row.right.plain));
	return clipAnsi(`${row.left.styled}${" ".repeat(padding)}${row.right.styled}`, width);
}

function workspacePathCandidates(workspacePath: string, homePath: string | undefined): readonly string[] {
	const safePath = singleLine(workspacePath) || ".";
	const safeHome = homePath ? singleLine(homePath) : undefined;
	let displayPath = safePath;
	if (safeHome) {
		const resolvedWorkspace = resolve(safePath);
		const resolvedHome = resolve(safeHome);
		const relativeToHome = relative(resolvedHome, resolvedWorkspace);
		const insideHome =
			relativeToHome === "" ||
			(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
		if (insideHome) displayPath = relativeToHome ? `~${sep}${relativeToHome}` : "~";
	}
	const leaf = basename(safePath) || safePath;
	const middleShortened =
		displayPath === leaf || displayPath === "~"
			? displayPath
			: `${displayPath.startsWith("~") ? "~" : ""}${sep}…${sep}${leaf}`;
	return unique([displayPath, middleShortened, leaf]);
}

function gitPresentation(git: GitStatusSnapshot | undefined, theme: TuiTheme): RenderedText | undefined {
	if (!git) return undefined;
	const reference = git.branch
		? singleLine(git.branch)
		: git.detachedHead
			? `@${singleLine(git.detachedHead).slice(0, 7)}`
			: "";
	if (!reference) return undefined;
	const open = styled(theme, "muted", `(${reference}`);
	const dirty = git.dirty ? styled(theme, "warning", "*") : undefined;
	const close = styled(theme, "muted", ")");
	return joinRendered([open, dirty, close], "");
}

function contextPresentation(context: StatusLineContextSnapshot, theme: TuiTheme): RenderedText {
	const used = formatStatusLineTokens(context.usedTokens);
	const window = formatStatusLineTokens(context.windowTokens);
	const value = `${context.estimated ? "~" : ""}${used}/${window}`;
	const ratio = context.windowTokens > 0 ? context.usedTokens / context.windowTokens : 0;
	return styled(theme, ratio >= 0.95 ? "error" : ratio >= 0.8 ? "warning" : "muted", value);
}

function modelPresentations(
	presentation: StatusLinePresentation,
	supportsReasoning: boolean,
	theme: TuiTheme,
): {
	readonly full: RenderedText;
	readonly withoutProvider: RenderedText;
	readonly truncate: (width: number) => RenderedText;
} {
	const label = singleLine(presentation.modelLabel) || "model";
	const slash = label.indexOf("/");
	const withoutProvider = slash >= 0 ? label.slice(slash + 1) : label;
	const reasoning = supportsReasoning ? `(${singleLine(presentation.reasoning) || "off"})` : "";
	const fullValue = `${label}${reasoning}`;
	const compactValue = `${withoutProvider}${reasoning}`;
	return {
		full: styled(theme, "accent", fullValue),
		withoutProvider: styled(theme, "accent", compactValue),
		truncate: (width) => styled(theme, "accent", truncateModel(withoutProvider, reasoning, width)),
	};
}

function truncateModel(model: string, suffix: string, width: number): string {
	const full = `${model}${suffix}`;
	if (displayWidth(full) <= width) return full;
	const suffixWidth = displayWidth(suffix);
	if (suffix && width > suffixWidth + 1) {
		return `${truncatePlain(model, width - suffixWidth)}${suffix}`;
	}
	return truncatePlain(full, width);
}

function truncatePlain(value: string, width: number): string {
	if (width <= 0) return "";
	if (displayWidth(value) <= width) return value;
	if (width === 1) return "…";
	return `${sliceAnsi(value, 0, width - 1)}…`;
}

function truncateRendered(
	value: RenderedText,
	width: number,
	theme: TuiTheme,
	tone: Parameters<TuiTheme["style"]>[0],
): RenderedText {
	return styled(theme, tone, truncatePlain(value.plain, width));
}

function formatUsd(value: number): string {
	const usd = Math.max(0, value);
	if (usd === 0) return "$0.00";
	if (usd < 0.0005) return "<$0.001";
	if (usd < 0.01) return `$${usd.toFixed(3)}`;
	return `$${usd.toFixed(2)}`;
}

function styled(theme: TuiTheme, tone: Parameters<TuiTheme["style"]>[0], value: string): RenderedText {
	return { plain: value, styled: theme.style(tone, value) };
}

function joinRendered(parts: readonly (RenderedText | undefined)[], separator: string, theme?: TuiTheme): RenderedText {
	const present = parts.filter((part): part is RenderedText => part !== undefined && part.plain.length > 0);
	const plain = present.map((part) => part.plain).join(separator);
	const styledSeparator = theme ? theme.style("muted", separator) : separator;
	return { plain, styled: present.map((part) => part.styled).join(styledSeparator) };
}

function fits(left: RenderedText | undefined, right: RenderedText | undefined, width: number): boolean {
	if (!left) return !right || displayWidth(right.plain) <= width;
	if (!right) return displayWidth(left.plain) <= width;
	return displayWidth(left.plain) + 2 + displayWidth(right.plain) <= width;
}

function singleLine(value: string): string {
	return sanitizeTerminalText(value).replace(/\s+/gu, " ").trim();
}

function trimDecimal(value: string): string {
	return value.endsWith(".0") ? value.slice(0, -2) : value;
}

function unique(values: readonly string[]): readonly string[] {
	return [...new Set(values)];
}
