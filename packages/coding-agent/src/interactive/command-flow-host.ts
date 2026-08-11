import { clipAnsi, sanitizeTerminalText, type TerminalInput } from "@coda/tui";
import { renderCommandList } from "./command-list.ts";
import type { TuiTheme } from "./theme.ts";

export interface CommandFlowNavigation {
	push(screen: CommandFlowScreen): void;
	replace?(screen: CommandFlowScreen): void;
	back(): void;
	close(): void;
}

export interface CommandFlowMenuItem {
	readonly id: string;
	readonly label: string;
	readonly description?: string;
	readonly status?: string;
	readonly disabledReason?: string;
	readonly onSelect?: (navigation: CommandFlowNavigation) => Promise<void> | void;
}

export interface CommandFlowMenu {
	readonly id: string;
	readonly title: string;
	readonly filterable?: boolean;
	readonly items: readonly CommandFlowMenuItem[];
}

export interface CommandFlowPrompt {
	readonly id: string;
	readonly title: string;
	readonly label: string;
	readonly placeholder?: string;
	readonly secret?: boolean;
	readonly initialValue?: string;
	readonly onSubmit: (value: string, navigation: CommandFlowNavigation) => Promise<void> | void;
}

export type CommandFlowScreen = CommandFlowMenu | CommandFlowPrompt;

export interface CommandFlowViewItem extends CommandFlowMenuItem {
	readonly selected: boolean;
}

export interface CommandFlowView {
	readonly breadcrumb: readonly string[];
	readonly menuId: string;
	readonly query?: string;
	readonly items: readonly CommandFlowViewItem[];
	readonly prompt?: {
		readonly label: string;
		readonly placeholder?: string;
		readonly displayValue: string;
		readonly secret: boolean;
	};
}

export type CommandFlowInputResult = { readonly type: "handled" } | { readonly type: "unhandled" };

interface CommandFlowFrame {
	readonly screen: CommandFlowScreen;
	selectedIndex: number;
	query: string;
	inputValue: string;
}

export class CommandFlowHost {
	readonly #stack: CommandFlowFrame[] = [];
	readonly #onChange: () => void;
	readonly #onError: (error: unknown) => void;
	readonly #navigation: CommandFlowNavigation = Object.freeze({
		push: (screen: CommandFlowScreen) => this.push(screen),
		replace: (screen: CommandFlowScreen) => this.replace(screen),
		back: () => this.back(),
		close: () => this.close(),
	});

	constructor(options: { readonly onChange?: () => void; readonly onError?: (error: unknown) => void } = {}) {
		this.#onChange = options.onChange ?? (() => undefined);
		this.#onError = options.onError ?? (() => undefined);
	}

	get view(): CommandFlowView | undefined {
		const current = this.#stack.at(-1);
		if (!current) return undefined;
		const breadcrumb = Object.freeze(this.#stack.map(({ screen }) => screen.title));
		if (!isMenu(current.screen)) {
			return Object.freeze({
				breadcrumb,
				menuId: current.screen.id,
				items: Object.freeze([]),
				prompt: Object.freeze({
					label: current.screen.label,
					placeholder: current.screen.placeholder,
					displayValue: current.screen.secret
						? "•".repeat(Array.from(current.inputValue).length)
						: current.inputValue,
					secret: current.screen.secret ?? false,
				}),
			});
		}
		const items = visibleItems(current);
		return Object.freeze({
			breadcrumb,
			menuId: current.screen.id,
			...(current.screen.filterable ? { query: current.query } : {}),
			items: Object.freeze(
				items.map((item, index) => Object.freeze({ ...item, selected: index === current.selectedIndex })),
			),
		});
	}

	open(screen: CommandFlowScreen): void {
		this.#stack.splice(0, this.#stack.length, createFrame(screen));
		this.#onChange();
	}

	push(screen: CommandFlowScreen): void {
		this.#stack.push(createFrame(screen));
		this.#onChange();
	}

	replace(screen: CommandFlowScreen): void {
		if (this.#stack.length === 0) {
			this.open(screen);
			return;
		}
		this.#stack[this.#stack.length - 1] = createFrame(screen);
		this.#onChange();
	}

	back(): void {
		this.#stack.pop();
		this.#onChange();
	}

	close(): void {
		this.#stack.splice(0, this.#stack.length);
		this.#onChange();
	}

	handleInput(input: TerminalInput): CommandFlowInputResult {
		const current = this.#stack.at(-1);
		if (!current) return { type: "unhandled" };
		const inserted =
			input.type === "text"
				? input.text
				: input.type === "paste"
					? input.text
					: input.type === "key" &&
							input.action !== "release" &&
							input.text &&
							!input.control &&
							!input.alt &&
							!input.meta
						? input.text
						: undefined;
		if (inserted !== undefined && (!isMenu(current.screen) || current.screen.filterable)) {
			const normalized = inserted.replace(/[\r\n]/gu, "");
			if (isMenu(current.screen)) current.query += normalized;
			else current.inputValue += normalized;
			current.selectedIndex = 0;
			this.#onChange();
			return { type: "handled" };
		}
		if (
			input.type !== "key" ||
			input.action === "release" ||
			input.control ||
			input.alt ||
			input.meta ||
			(input.key !== "enter" &&
				input.key !== "escape" &&
				input.key !== "up" &&
				input.key !== "down" &&
				input.key !== "backspace")
		) {
			return { type: "unhandled" };
		}
		if (input.key === "escape") {
			this.back();
			return { type: "handled" };
		}
		if (input.key === "backspace") {
			if (isMenu(current.screen) && !current.screen.filterable) return { type: "unhandled" };
			if (isMenu(current.screen)) current.query = Array.from(current.query).slice(0, -1).join("");
			else current.inputValue = Array.from(current.inputValue).slice(0, -1).join("");
			current.selectedIndex = 0;
			this.#onChange();
			return { type: "handled" };
		}
		if (!isMenu(current.screen)) {
			const prompt = current.screen;
			if (input.key === "enter") {
				this.#runAction(() => prompt.onSubmit(current.inputValue, this.#navigation));
			}
			return { type: "handled" };
		}
		const items = visibleItems(current);
		if (input.key === "up" || input.key === "down") {
			if (items.length > 0) {
				const delta = input.key === "up" ? -1 : 1;
				current.selectedIndex = (current.selectedIndex + delta + items.length) % items.length;
			}
			this.#onChange();
			return { type: "handled" };
		}
		const selected = items[current.selectedIndex];
		if (selected && !selected.disabledReason && selected.onSelect) {
			this.#runAction(() => selected.onSelect!(this.#navigation));
		}
		return { type: "handled" };
	}

	#runAction(action: () => Promise<void> | void): void {
		let result: Promise<void> | void;
		try {
			result = action();
		} catch (error) {
			this.#onError(error);
			return;
		}
		if (isPromiseLike(result)) void Promise.resolve(result).catch(this.#onError);
	}
}

export function renderCommandFlow(
	view: CommandFlowView,
	width: number,
	maxItems: number,
	theme: TuiTheme,
): readonly string[] {
	const availableWidth = Math.max(0, Math.floor(width));
	if (availableWidth === 0) return Object.freeze([]);
	const breadcrumb = sanitizeTerminalText(
		`${view.breadcrumb.join(" › ")}${view.query ? ` · ${view.query}` : ""}`,
	).replace(/[\r\n]+/gu, " ");
	const heading = theme.style("muted", clipAnsi(`  ${breadcrumb}`, availableWidth));
	if (view.prompt) {
		const value = view.prompt.displayValue || view.prompt.placeholder || "";
		return Object.freeze([
			heading,
			clipAnsi(`  ${view.prompt.label}: ${sanitizeTerminalText(value).replace(/[\r\n]+/gu, " ")}`, availableWidth),
		]);
	}
	const rows = renderCommandList(
		view.items.map((item) => ({
			primary: item.label,
			description: item.disabledReason ?? item.status ?? item.description,
			descriptionTone: item.disabledReason ? ("warning" as const) : ("muted" as const),
			selected: item.selected,
		})),
		availableWidth,
		maxItems,
		theme,
		"No matching options",
	);
	return Object.freeze([heading, ...rows]);
}

function visibleItems(frame: CommandFlowFrame): readonly CommandFlowMenuItem[] {
	if (!isMenu(frame.screen)) return [];
	const query = normalize(frame.query);
	if (!frame.screen.filterable || query.length === 0) return frame.screen.items;
	return frame.screen.items.filter((item) => {
		const value = normalize(`${item.label} ${item.description ?? ""} ${item.status ?? ""}`);
		return value.includes(query) || isSubsequence(query, value);
	});
}

function createFrame(screen: CommandFlowScreen): CommandFlowFrame {
	return {
		screen,
		selectedIndex: 0,
		query: "",
		inputValue: isMenu(screen) ? "" : (screen.initialValue ?? ""),
	};
}

function isMenu(screen: CommandFlowScreen): screen is CommandFlowMenu {
	return "items" in screen;
}

function isPromiseLike(value: unknown): value is PromiseLike<void> {
	return (
		typeof value === "object" &&
		value !== null &&
		"then" in value &&
		typeof (value as { readonly then?: unknown }).then === "function"
	);
}

function normalize(value: string): string {
	return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

function isSubsequence(query: string, value: string): boolean {
	let index = 0;
	for (const character of value) {
		if (character === query[index]) index++;
		if (index === query.length) return true;
	}
	return false;
}
