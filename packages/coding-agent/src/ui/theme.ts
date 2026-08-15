import { type ColorLevel, styleAnsi, type TerminalAppearance } from "@coda/tui";

export type ThemeTone = "accent" | "success" | "error" | "warning" | "muted" | "code" | "strong" | "thinking";
export type ThemeSurface = "panel" | "selection";
export type ThemeSurfaceTone = "normal" | "muted" | "accent" | "warning" | "strong" | "emphasis" | "code";

export interface TuiTheme {
	readonly colorLevel: ColorLevel;
	readonly appearance: TerminalAppearance;
	readonly surfaceFilled: boolean;
	style(tone: ThemeTone, value: string): string;
	styleOnSurface(surface: ThemeSurface, tone: ThemeSurfaceTone, value: string): string;
	styleEditorBorder(reasoning: string, focused: boolean, value: string): string;
}

type Rgb = readonly [number, number, number];

interface SurfaceColors {
	readonly background: Rgb;
	readonly normal: Rgb;
	readonly muted: Rgb;
	readonly accent: Rgb;
	readonly warning: Rgb;
}

const SURFACE_COLORS = {
	dark: {
		panel: {
			background: [66, 70, 78],
			normal: [220, 223, 228],
			muted: [172, 177, 185],
			accent: [114, 224, 207],
			warning: [255, 211, 105],
		},
		selection: {
			background: [66, 70, 78],
			normal: [220, 223, 228],
			muted: [172, 177, 185],
			accent: [114, 224, 207],
			warning: [255, 224, 145],
		},
	},
	light: {
		panel: {
			background: [245, 245, 245],
			normal: [32, 36, 43],
			muted: [91, 97, 107],
			accent: [0, 95, 135],
			warning: [122, 76, 0],
		},
		selection: {
			background: [245, 245, 245],
			normal: [32, 36, 43],
			muted: [91, 97, 107],
			accent: [0, 95, 135],
			warning: [105, 65, 0],
		},
	},
} as const satisfies Readonly<
	Record<Exclude<TerminalAppearance, "unknown">, Readonly<Record<ThemeSurface, SurfaceColors>>>
>;

const SGR_BY_TONE: Readonly<Record<ThemeTone, string>> = Object.freeze({
	accent: "36",
	success: "1;32",
	error: "1;31",
	warning: "33",
	muted: "2",
	code: "36",
	strong: "1",
	thinking: "2;3",
});

const EDITOR_BORDER_RGB: Readonly<Record<string, readonly [number, number, number]>> = Object.freeze({
	off: [80, 80, 80],
	minimal: [110, 110, 110],
	low: [95, 135, 175],
	medium: [129, 162, 190],
	high: [178, 148, 187],
	xhigh: [209, 131, 232],
	max: [255, 95, 255],
});

const ANSI_16: readonly (readonly [number, number, number, number])[] = Object.freeze([
	[0, 0, 0, 30],
	[205, 0, 0, 31],
	[0, 205, 0, 32],
	[205, 205, 0, 33],
	[0, 0, 238, 34],
	[205, 0, 205, 35],
	[0, 205, 205, 36],
	[229, 229, 229, 37],
	[127, 127, 127, 90],
	[255, 0, 0, 91],
	[0, 255, 0, 92],
	[255, 255, 0, 93],
	[92, 92, 255, 94],
	[255, 0, 255, 95],
	[0, 255, 255, 96],
	[255, 255, 255, 97],
]);

export function createCodaTheme(colorLevel: ColorLevel, appearance: TerminalAppearance = "unknown"): TuiTheme {
	const style = (tone: ThemeTone, value: string) => (colorLevel === 0 ? value : styleAnsi(SGR_BY_TONE[tone], value));
	return Object.freeze({
		colorLevel,
		appearance,
		surfaceFilled: colorLevel > 0 && appearance !== "unknown",
		style,
		styleOnSurface: (surface: ThemeSurface, tone: ThemeSurfaceTone, value: string) => {
			if (colorLevel === 0 || value.length === 0) return value;
			const colorTone = tone === "strong" || tone === "emphasis" ? "normal" : tone === "code" ? "accent" : tone;
			const modifier = tone === "strong" || tone === "accent" ? "1" : tone === "emphasis" ? "3" : undefined;
			if (appearance === "unknown") {
				const foreground =
					colorTone === "accent" ? "36" : colorTone === "warning" ? "33" : colorTone === "muted" ? "2" : undefined;
				const parameters = [modifier, foreground].filter(Boolean).join(";");
				return parameters ? styleAnsi(parameters, value) : value;
			}
			const colors = SURFACE_COLORS[appearance][surface];
			const foreground = foregroundSgr(colors[colorTone], colorLevel);
			return styleAnsi(
				`${modifier ? `${modifier};` : ""}${foreground};${backgroundSgr(colors.background, colorLevel)}`,
				value,
			);
		},
		styleEditorBorder: (reasoning: string, focused: boolean, value: string) => {
			if (!focused) return style("muted", value);
			if (colorLevel === 0 || value.length === 0) return value;
			const [red, green, blue] = EDITOR_BORDER_RGB[reasoning] ?? EDITOR_BORDER_RGB.off!;
			const foreground =
				colorLevel === 3
					? `38;2;${red};${green};${blue}`
					: colorLevel === 2
						? `38;5;${nearestAnsi256(red, green, blue)}`
						: nearestAnsi16(red, green, blue).toString();
			return `\x1b[${foreground}m${value}\x1b[0m`;
		},
	});
}

function foregroundSgr([red, green, blue]: Rgb, colorLevel: Exclude<ColorLevel, 0>): string {
	if (colorLevel === 3) return `38;2;${red};${green};${blue}`;
	if (colorLevel === 2) return `38;5;${nearestAnsi256(red, green, blue)}`;
	return nearestAnsi16(red, green, blue).toString();
}

function backgroundSgr([red, green, blue]: Rgb, colorLevel: Exclude<ColorLevel, 0>): string {
	if (colorLevel === 3) return `48;2;${red};${green};${blue}`;
	if (colorLevel === 2) return `48;5;${nearestAnsi256(red, green, blue)}`;
	return (nearestAnsi16(red, green, blue) + 10).toString();
}

function nearestAnsi256(red: number, green: number, blue: number): number {
	const levels = [0, 95, 135, 175, 215, 255] as const;
	const indexes = [red, green, blue].map((channel) => nearestLevelIndex(channel, levels));
	const cube = levels[indexes[0]!]!;
	const cubeGreen = levels[indexes[1]!]!;
	const cubeBlue = levels[indexes[2]!]!;
	const cubeError = colorDistance(red, green, blue, cube, cubeGreen, cubeBlue);
	const grayIndex = Math.max(0, Math.min(23, Math.round(((red + green + blue) / 3 - 8) / 10)));
	const gray = 8 + grayIndex * 10;
	const grayError = colorDistance(red, green, blue, gray, gray, gray);
	return grayError < cubeError ? 232 + grayIndex : 16 + 36 * indexes[0]! + 6 * indexes[1]! + indexes[2]!;
}

function nearestLevelIndex(channel: number, levels: readonly number[]): number {
	let best = 0;
	for (let index = 1; index < levels.length; index++) {
		if (Math.abs(channel - levels[index]!) < Math.abs(channel - levels[best]!)) best = index;
	}
	return best;
}

function nearestAnsi16(red: number, green: number, blue: number): number {
	return ANSI_16.reduce(
		(best, candidate) =>
			colorDistance(red, green, blue, candidate[0], candidate[1], candidate[2]) <
			colorDistance(red, green, blue, best[0], best[1], best[2])
				? candidate
				: best,
		ANSI_16[0]!,
	)[3];
}

function colorDistance(
	leftRed: number,
	leftGreen: number,
	leftBlue: number,
	rightRed: number,
	rightGreen: number,
	rightBlue: number,
): number {
	return (leftRed - rightRed) ** 2 + (leftGreen - rightGreen) ** 2 + (leftBlue - rightBlue) ** 2;
}
