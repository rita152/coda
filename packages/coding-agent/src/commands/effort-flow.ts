import type { ModelThinkingLevel } from "@coda/ai";
import type { CommandFlowMenu, CommandFlowNavigation } from "../interactive/command-flow-host.ts";

export interface EffortCommandFlowOptions {
	readonly current: ModelThinkingLevel;
	readonly available: readonly ModelThinkingLevel[];
	readonly onSelect: (effort: ModelThinkingLevel) => Promise<unknown> | unknown;
}

const PRESENTATION: Readonly<Record<ModelThinkingLevel, { readonly label: string; readonly description: string }>> =
	Object.freeze({
		off: Object.freeze({ label: "Off", description: "Disable model reasoning" }),
		minimal: Object.freeze({ label: "Minimal", description: "Use the smallest reasoning effort" }),
		low: Object.freeze({ label: "Low", description: "Use a small reasoning effort" }),
		medium: Object.freeze({ label: "Medium", description: "Balance reasoning depth and latency" }),
		high: Object.freeze({ label: "High", description: "Use a large reasoning effort" }),
		xhigh: Object.freeze({ label: "Extra High", description: "Use an extra-large reasoning effort" }),
		max: Object.freeze({ label: "Maximum", description: "Use the model's maximum reasoning effort" }),
	});

export function createEffortCommandFlow(options: EffortCommandFlowOptions): CommandFlowMenu {
	return Object.freeze({
		id: "effort",
		title: "Reasoning Effort",
		items: Object.freeze(
			options.available.map((effort) => {
				const presentation = PRESENTATION[effort];
				return Object.freeze({
					id: effort,
					label: presentation.label,
					description: presentation.description,
					status: options.current === effort ? "current" : undefined,
					onSelect: (navigation: CommandFlowNavigation) => finishSelection(options.onSelect(effort), navigation),
				});
			}),
		),
	});
}

function finishSelection(result: Promise<unknown> | unknown, navigation: CommandFlowNavigation): Promise<void> | void {
	if (isPromiseLike(result)) return Promise.resolve(result).then(() => navigation.close());
	navigation.close();
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		"then" in value &&
		typeof (value as { readonly then?: unknown }).then === "function"
	);
}
