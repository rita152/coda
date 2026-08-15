import { clipAnsi, displayWidth, sanitizeTerminalText, styleAnsi, type TerminalAppearance } from "@coda/tui";
import type { ActivityStatus } from "./activity-status.ts";
import type { TuiTheme } from "./theme.ts";

export interface ActivityStatusRenderOptions {
	readonly width: number;
	readonly now: number;
	readonly theme: TuiTheme;
	readonly motion: "full" | "reduced";
}

type Rgb = readonly [number, number, number];

const SHIMMER_PALETTE = Object.freeze({
	dark: { background: [28, 30, 34], foreground: [229, 231, 235] },
	light: { background: [246, 246, 246], foreground: [31, 35, 41] },
}) satisfies Readonly<Record<Exclude<TerminalAppearance, "unknown">, { background: Rgb; foreground: Rgb }>>;

const SHIMMER_PERIOD_MS = 2_000;
const SHIMMER_PADDING = 10;
const SHIMMER_BAND_HALF_WIDTH = 5;

export function renderActivityStatus(status: ActivityStatus, options: ActivityStatusRenderOptions): string {
	if (!Number.isSafeInteger(options.width) || options.width < 1) {
		throw new RangeError("Activity status width must be a positive integer");
	}
	const text = inline(status.text) || "Working...";
	const elapsed = formatElapsed(Math.max(0, options.now - status.startedAt));
	const age = Math.max(0, options.now - status.lastEventAt);
	const fullMetadata = ` · ${elapsed} · updated ${age < 1_000 ? "now" : `${formatElapsed(age)} ago`}`;
	const elapsedMetadata = ` · ${elapsed}`;
	const metadata = chooseMetadata(text, options.width, fullMetadata, elapsedMetadata);
	const textWidth = Math.max(1, options.width - displayWidth(metadata));
	const clippedText = clipAnsi(text, textWidth, { ellipsis: "…" });
	const renderedText =
		status.motion === "waiting"
			? options.theme.style("warning", clippedText)
			: options.motion === "full" && options.theme.colorLevel > 0
				? shimmerText(clippedText, Math.max(0, options.now - status.startedAt), options.theme)
				: options.theme.style("muted", clippedText);
	return clipAnsi(`${renderedText}${options.theme.style("muted", metadata)}`, options.width);
}

/**
 * A behavioral reimplementation of Codex's two-second, padded cosine-band shimmer.
 * Coda uses its negotiated terminal appearance rather than depending on a Codex palette.
 */
export function shimmerText(text: string, elapsedMs: number, theme: TuiTheme): string {
	if (text.length === 0 || theme.colorLevel === 0) return text;
	const characters = Array.from(text);
	const period = characters.length + SHIMMER_PADDING * 2;
	const position = ((Math.max(0, elapsedMs) % SHIMMER_PERIOD_MS) / SHIMMER_PERIOD_MS) * period;
	return characters
		.map((character, index) => {
			const distance = Math.abs(index + SHIMMER_PADDING - position);
			const intensity =
				distance <= SHIMMER_BAND_HALF_WIDTH
					? 0.5 * (1 + Math.cos((Math.PI * distance) / SHIMMER_BAND_HALF_WIDTH))
					: 0;
			if (theme.colorLevel === 3 && theme.appearance !== "unknown") {
				const palette = SHIMMER_PALETTE[theme.appearance];
				const color = blend(palette.background, palette.foreground, intensity * 0.9);
				return styleAnsi(`1;38;2;${color[0]};${color[1]};${color[2]}`, character);
			}
			if (intensity < 0.2) return styleAnsi("2", character);
			if (intensity < 0.6) return character;
			return styleAnsi("1", character);
		})
		.join("");
}

function chooseMetadata(text: string, width: number, full: string, elapsed: string): string {
	if (displayWidth(text) + displayWidth(full) <= width) return full;
	if (displayWidth(text) + displayWidth(elapsed) <= width) return elapsed;
	if (width >= 32 && displayWidth(elapsed) <= Math.floor(width / 3)) return elapsed;
	return "";
}

function inline(value: string): string {
	return sanitizeTerminalText(value)
		.replace(/[\r\n\t]+/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
}

function formatElapsed(durationMs: number): string {
	const seconds = Math.floor(durationMs / 1_000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
}

function blend(background: Rgb, foreground: Rgb, amount: number): Rgb {
	const channel = (index: number) =>
		Math.round(background[index]! + (foreground[index]! - background[index]!) * Math.max(0, Math.min(1, amount)));
	return [channel(0), channel(1), channel(2)];
}
