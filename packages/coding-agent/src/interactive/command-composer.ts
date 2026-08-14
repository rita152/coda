import type { Editor, TerminalInput } from "@coda/tui";
import {
	type CommandInvocation,
	type CommandQuery,
	parseCommandQuery,
	resolveCommandInvocation,
} from "../commands/parser.ts";
import type { CommandRegistry } from "../commands/registry.ts";
import type { CommandDefinition, CommandMatch, CommandSource } from "../commands/types.ts";
import type { ComposerExtensionReference } from "../session/composer-submission.ts";
import { renderCommandList } from "./command-list.ts";
import { addExtensionReference, extensionReferencesFromMarkers } from "./extension-references.ts";
import type { TuiTheme } from "./theme.ts";

export interface CommandPaletteItem {
	readonly commandId: string;
	readonly label: string;
	readonly sourceTag: `<${CommandSource}>`;
	readonly title: string;
	readonly selected: boolean;
}

export interface CommandPalette {
	readonly query: CommandQuery;
	readonly items: readonly CommandPaletteItem[];
}

export type CommandComposerInputResult =
	| { readonly type: "handled" }
	| { readonly type: "invoke"; readonly command: CommandDefinition }
	| { readonly type: "unhandled" };

export interface CommandComposerOptions {
	readonly isAvailable?: (command: CommandDefinition) => boolean;
}

export class CommandComposer {
	readonly #registry: CommandRegistry;
	readonly #editor: Editor;
	readonly #isAvailable: (command: CommandDefinition) => boolean;
	#selectionKey?: string;
	#dismissedKey?: string;
	#rawPromptSignature?: string;
	#preferredCommandId?: string;
	#selectedIndex = 0;

	constructor(registry: CommandRegistry, editor: Editor, options: CommandComposerOptions = {}) {
		this.#registry = registry;
		this.#editor = editor;
		this.#isAvailable = options.isAvailable ?? (() => true);
	}

	get extensionReferences(): readonly ComposerExtensionReference[] {
		return extensionReferencesFromMarkers(this.#editor.markers);
	}

	/** Inserts a selected Skill as a visible mention while retaining its structured command identity. */
	insertSkillReference(commandId: string): void {
		const command = this.#registry.findById(commandId);
		if (!command || command.source !== "skill" || command.kind !== "extension") {
			throw new Error(`Unknown Skill command: ${commandId}`);
		}
		const start = this.#editor.cursorOffset;
		const prefix = start > 0 && !/\s/u.test(this.#editor.text[start - 1] ?? "") ? " " : "";
		const token = `$${command.name}`;
		this.#editor.replaceRange(start, start, `${prefix}${token} `);
		addExtensionReference(this.#editor, command, start + prefix.length, start + prefix.length + token.length);
		this.#selectionKey = undefined;
		this.#dismissedKey = undefined;
		this.#rawPromptSignature = this.#editorSignature();
	}

	get palette(): CommandPalette | undefined {
		const active = this.#activePalette();
		if (!active) return undefined;
		return Object.freeze({
			query: active.query,
			items: Object.freeze(
				active.matches.map(({ command }, index) =>
					Object.freeze({
						commandId: command.id,
						label: `/${command.name}`,
						sourceTag: `<${command.source}>` as const,
						title: command.title,
						selected: index === this.#selectedIndex,
					}),
				),
			),
		});
	}

	resolveSubmission(text: string): CommandInvocation | undefined {
		if (this.extensionReferences.length > 0) return undefined;
		if (this.#rawPromptSignature === this.#editorSignature()) {
			this.#rawPromptSignature = undefined;
			this.#dismissedKey = undefined;
			return undefined;
		}
		const invocation = resolveCommandInvocation(this.#registry, text);
		return invocation && this.#isAvailable(invocation.command) ? invocation : undefined;
	}

	handleInput(input: TerminalInput): CommandComposerInputResult {
		if (
			input.type !== "key" ||
			input.action === "release" ||
			!isCommandPaletteKey(input.key) ||
			input.control ||
			input.alt ||
			input.meta
		) {
			return { type: "unhandled" };
		}
		const active = this.#activePalette();
		if (!active) return { type: "unhandled" };
		if (input.key === "escape") {
			this.#dismissedKey = active.key;
			this.#rawPromptSignature = this.#editorSignature();
			return { type: "handled" };
		}
		if (input.key === "up" || input.key === "down") {
			const delta = input.key === "up" ? -1 : 1;
			this.#selectedIndex = (this.#selectedIndex + delta + active.matches.length) % active.matches.length;
			return { type: "handled" };
		}
		const match = active.matches[this.#selectedIndex]!;
		if (input.key === "tab") {
			const token = `/${match.command.name}`;
			this.#preferredCommandId = match.command.id;
			this.#editor.replaceRange(active.query.range.start, active.query.range.end, token);
			return { type: "handled" };
		}
		if (input.shift) return { type: "unhandled" };
		if (match.command.kind === "extension") {
			const token = `/${match.command.name}`;
			this.#editor.replaceRange(active.query.range.start, active.query.range.end, `${token} `);
			addExtensionReference(
				this.#editor,
				match.command,
				active.query.range.start,
				active.query.range.start + token.length,
			);
			this.#rawPromptSignature = this.#editorSignature();
			return { type: "handled" };
		}
		if (match.command.arguments.kind === "tail" && match.command.arguments.required) {
			this.#editor.replaceRange(active.query.range.start, active.query.range.end, `/${match.command.name} `);
			return { type: "handled" };
		}
		return { type: "invoke", command: match.command };
	}

	#activePalette(): ActiveCommandPalette | undefined {
		if (this.#rawPromptSignature !== this.#editorSignature()) this.#rawPromptSignature = undefined;
		const query = parseCommandQuery(this.#editor.text, this.#editor.cursorOffset);
		if (!query) {
			this.#selectionKey = undefined;
			this.#preferredCommandId = undefined;
			return undefined;
		}
		const matches = this.#registry
			.search(query.query, { location: query.location })
			.filter(({ command }) => this.#isAvailable(command));
		if (matches.length === 0) {
			this.#selectionKey = undefined;
			return undefined;
		}
		const selectionKey = `${this.#editor.text}\u0000${this.#editor.cursorOffset}\u0000${matches
			.map(({ command }) => command.id)
			.join("\u0000")}`;
		if (selectionKey !== this.#selectionKey) {
			this.#selectionKey = selectionKey;
			const preferredIndex = this.#preferredCommandId
				? matches.findIndex(({ command }) => command.id === this.#preferredCommandId)
				: -1;
			this.#selectedIndex = preferredIndex >= 0 ? preferredIndex : 0;
			this.#preferredCommandId = undefined;
		}
		if (selectionKey === this.#dismissedKey) return undefined;
		this.#dismissedKey = undefined;
		return { key: selectionKey, query, matches };
	}

	#editorSignature(): string {
		return `${this.#editor.text}\u0000${this.#editor.cursorOffset}`;
	}
}

interface ActiveCommandPalette {
	readonly key: string;
	readonly query: CommandQuery;
	readonly matches: readonly CommandMatch[];
}

function isCommandPaletteKey(key: string): key is "tab" | "enter" | "up" | "down" | "escape" {
	return key === "tab" || key === "enter" || key === "up" || key === "down" || key === "escape";
}

export function renderCommandPalette(
	palette: CommandPalette,
	width: number,
	maxItems: number,
	theme: TuiTheme,
): readonly string[] {
	return renderCommandList(
		palette.items.map((item) => ({
			primary: `${item.label} ${item.sourceTag}`,
			description: item.title,
			selected: item.selected,
		})),
		width,
		maxItems,
		theme,
		"No matching commands",
	);
}
