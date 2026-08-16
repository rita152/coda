import { clipAnsi, displayWidth, sanitizeTerminalText } from "@coda/tui";
import type { TuiTheme } from "./theme.ts";

const PRIMARY_COLUMN_GAP = 2;
const MINIMUM_PRIMARY_COLUMN_WIDTH = 12;
const MAXIMUM_PRIMARY_COLUMN_WIDTH = 32;
const MINIMUM_DESCRIPTION_WIDTH = 10;

export interface CommandListItem {
	readonly primary: string;
	readonly description?: string;
	readonly descriptionTone?: "muted" | "warning";
	readonly selected: boolean;
}

export interface DetailedCommandListItem extends CommandListItem {
	readonly status?: string;
	readonly disabledReason?: string;
}

/**
 * Render the shared Pi-style command list without a surrounding panel.
 * The caller controls whether the list sits above or below its input.
 */
export function renderCommandList(
	items: readonly CommandListItem[],
	width: number,
	maxItems: number,
	theme: TuiTheme,
	emptyMessage = "No matching options",
): readonly string[] {
	const availableWidth = Math.max(0, Math.floor(width));
	if (availableWidth === 0) return Object.freeze([]);
	if (items.length === 0) {
		return Object.freeze([theme.style("muted", clipAnsi(`  ${emptyMessage}`, availableWidth))]);
	}

	const itemLimit = Math.max(1, Math.floor(maxItems));
	const selectedIndex = Math.max(
		0,
		items.findIndex(({ selected }) => selected),
	);
	const start = Math.max(
		0,
		Math.min(selectedIndex - Math.floor(itemLimit / 2), Math.max(0, items.length - itemLimit)),
	);
	const end = Math.min(start + itemLimit, items.length);
	const primaryColumnWidth = commandPrimaryColumnWidth(items);
	const lines = items
		.slice(start, end)
		.map((item) => renderCommandListItem(item, availableWidth, primaryColumnWidth, theme));

	if (start > 0 || end < items.length) {
		const position = `  (${selectedIndex + 1}/${items.length})`;
		lines.push(theme.style("muted", clipAnsi(position, Math.max(0, availableWidth - 2))));
	}

	return Object.freeze(lines);
}

/** Renders Codex-style two-line records with a full-width title and compact metadata. */
export function renderDetailedCommandList(
	items: readonly DetailedCommandListItem[],
	width: number,
	maxLines: number,
	theme: TuiTheme,
	emptyMessage = "No matching options",
): readonly string[] {
	const availableWidth = Math.max(0, Math.floor(width));
	const lineLimit = Math.max(0, Math.floor(maxLines));
	if (availableWidth === 0 || lineLimit === 0) return Object.freeze([]);
	if (items.length === 0) {
		return Object.freeze([theme.style("muted", clipAnsi(`  ${emptyMessage}`, availableWidth))]);
	}

	const selectedIndex = Math.max(
		0,
		items.findIndex(({ selected }) => selected),
	);
	const maximumWithoutPosition = Math.max(1, Math.floor(lineLimit / 2));
	const showPosition = items.length > maximumWithoutPosition && lineLimit >= 3;
	const itemLimit = Math.max(1, Math.floor((lineLimit - (showPosition ? 1 : 0)) / 2));
	const start = Math.max(
		0,
		Math.min(selectedIndex - Math.floor(itemLimit / 2), Math.max(0, items.length - itemLimit)),
	);
	const end = Math.min(start + itemLimit, items.length);
	const lines: string[] = [];
	for (const item of items.slice(start, end)) {
		const prefix = item.selected ? "❯ " : "  ";
		const title = clipAnsi(singleLine(item.primary), Math.max(0, availableWidth - displayWidth(prefix)));
		const titleLine = clipAnsi(`${prefix}${title}`, availableWidth);
		lines.push(item.selected ? theme.style("accent", titleLine) : titleLine);

		if (lines.length >= lineLimit) break;
		const metadata = [item.disabledReason, item.status, item.description].filter(isPresent).join(" · ");
		const metadataLine = clipAnsi(`  ${singleLine(metadata)}`, availableWidth);
		lines.push(theme.style(item.disabledReason ? "warning" : "muted", metadataLine));
	}

	if (showPosition && lines.length < lineLimit) {
		lines.push(theme.style("muted", clipAnsi(`  (${selectedIndex + 1}/${items.length})`, availableWidth)));
	}
	return Object.freeze(lines.slice(0, lineLimit));
}

function renderCommandListItem(
	item: CommandListItem,
	width: number,
	primaryColumnWidth: number,
	theme: TuiTheme,
): string {
	const prefix = item.selected ? "→ " : "  ";
	const prefixWidth = displayWidth(prefix);
	const primary = singleLine(item.primary);
	const description = item.description ? singleLine(item.description) : undefined;

	if (description && width > 40) {
		const effectivePrimaryColumnWidth = Math.max(1, Math.min(primaryColumnWidth, width - prefixWidth - 4));
		const maximumPrimaryWidth = Math.max(1, effectivePrimaryColumnWidth - PRIMARY_COLUMN_GAP);
		const clippedPrimary = clipAnsi(primary, maximumPrimaryWidth);
		const spacing = " ".repeat(Math.max(1, effectivePrimaryColumnWidth - displayWidth(clippedPrimary)));
		const descriptionStart = prefixWidth + displayWidth(clippedPrimary) + spacing.length;
		const remainingWidth = width - descriptionStart - 2;
		if (remainingWidth > MINIMUM_DESCRIPTION_WIDTH) {
			const clippedDescription = clipAnsi(description, remainingWidth);
			const row = `${prefix}${clippedPrimary}${spacing}${clippedDescription}`;
			if (item.selected) return theme.style("accent", row);
			return `${prefix}${clippedPrimary}${theme.style(
				item.descriptionTone ?? "muted",
				`${spacing}${clippedDescription}`,
			)}`;
		}
	}

	const maximumPrimaryWidth = Math.max(0, width - prefixWidth - 2);
	const row = clipAnsi(`${prefix}${clipAnsi(primary, maximumPrimaryWidth)}`, width);
	return item.selected ? theme.style("accent", row) : row;
}

function commandPrimaryColumnWidth(items: readonly CommandListItem[]): number {
	const widest = items.reduce(
		(maximum, item) => Math.max(maximum, displayWidth(singleLine(item.primary)) + PRIMARY_COLUMN_GAP),
		0,
	);
	return Math.max(MINIMUM_PRIMARY_COLUMN_WIDTH, Math.min(MAXIMUM_PRIMARY_COLUMN_WIDTH, widest));
}

function singleLine(value: string): string {
	return sanitizeTerminalText(value)
		.replace(/[\r\n]+/gu, " ")
		.trim();
}

function isPresent(value: string | undefined): value is string {
	return value !== undefined && value.length > 0;
}
