import type { Editor, TerminalInput } from "@coda/tui";
import type { WorkspaceFileSearch, WorkspaceFileSearchSession } from "../host/workspace-file-search.ts";
import { renderCommandList } from "./command-list.ts";
import type { TuiTheme } from "./theme.ts";

const FILE_MENTION_MARKER_KIND = "file-mention";

export interface FileMentionQuery {
	readonly query: string;
	readonly range: {
		readonly start: number;
		readonly end: number;
	};
}

interface FileMentionPaletteItem {
	readonly path: string;
	readonly selected: boolean;
}

export interface FileMentionPalette {
	readonly status: "loading" | "ready" | "error";
	readonly items: readonly FileMentionPaletteItem[];
}

type FileMentionComposerInputResult = { readonly type: "handled" } | { readonly type: "unhandled" };

interface FileMentionRequest {
	readonly key: string;
	readonly status: FileMentionPalette["status"];
	readonly paths: readonly string[];
	selectedIndex: number;
}

export function parseFileMentionQuery(text: string, cursor: number): FileMentionQuery | undefined {
	if (!Number.isInteger(cursor) || cursor < 0 || cursor > text.length) {
		throw new RangeError("File mention query cursor is outside the Composer text");
	}
	if (cursor < text.length && text[cursor] !== " ") return undefined;
	const prefix = text.slice(0, cursor);
	const match = /(?:^| )@([^@\r\n]*)$/u.exec(prefix);
	if (!match) return undefined;
	const query = match[1]!;
	const start = cursor - query.length - 1;
	return Object.freeze({
		query,
		range: Object.freeze({ start, end: cursor }),
	});
}

export class FileMentionComposer {
	readonly #editor: Editor;
	readonly #search: WorkspaceFileSearch;
	readonly #invalidate: () => void;
	#searchSession?: WorkspaceFileSearchSession;
	#mentionStart?: number;
	#request?: FileMentionRequest;
	#dismissedKey?: string;
	#nextMarkerId = 0;

	constructor(editor: Editor, search: WorkspaceFileSearch, options: { readonly invalidate: () => void }) {
		this.#editor = editor;
		this.#search = search;
		this.#invalidate = options.invalidate;
	}

	get palette(): FileMentionPalette | undefined {
		this.#refresh();
		const query = this.#activeQuery();
		if (!query) return undefined;
		const key = this.#queryKey();
		const request = this.#request;
		if (key === this.#dismissedKey || request?.key !== key) return undefined;
		return Object.freeze({
			status: request.status,
			items: Object.freeze(
				request.paths.map((path, index) => Object.freeze({ path, selected: index === request.selectedIndex })),
			),
		});
	}

	#refresh(): void {
		const query = this.#activeQuery();
		if (!query) {
			this.#clearActiveMention();
			this.#dismissedKey = undefined;
			return;
		}
		const key = this.#queryKey();
		if (this.#dismissedKey !== undefined && this.#dismissedKey !== key) this.#dismissedKey = undefined;
		if (key === this.#dismissedKey) return;
		if (!this.#searchSession || this.#mentionStart !== query.range.start) {
			this.#searchSession = this.#search.startSession();
			this.#mentionStart = query.range.start;
			this.#request = undefined;
		}
		if (key === this.#request?.key) return;

		const request: FileMentionRequest = { key, status: "loading", paths: [], selectedIndex: 0 };
		this.#request = request;
		this.#invalidate();

		const searchSession = this.#searchSession;
		let operation: Promise<readonly string[]>;
		try {
			operation = searchSession(query.query);
		} catch (error) {
			operation = Promise.reject(error);
		}
		void operation.then(
			(paths) => {
				if (this.#request !== request) return;
				const sanitized = sanitizePaths(paths);
				this.#request = {
					key,
					status: "ready",
					paths: sanitized,
					selectedIndex: Math.min(request.selectedIndex, Math.max(0, sanitized.length - 1)),
				};
				this.#invalidate();
			},
			() => {
				if (this.#request !== request) return;
				this.#request = { key, status: "error", paths: [], selectedIndex: 0 };
				this.#invalidate();
			},
		);
	}

	handleInput(input: TerminalInput): FileMentionComposerInputResult {
		if (
			input.type !== "key" ||
			input.action === "release" ||
			!isFileMentionPaletteKey(input.key) ||
			input.control ||
			input.alt ||
			input.meta
		) {
			return { type: "unhandled" };
		}
		this.#refresh();
		const query = this.#activeQuery();
		if (!query) return { type: "unhandled" };
		const key = this.#queryKey();
		const request = this.#request;
		if (key === this.#dismissedKey || request?.key !== key) return { type: "unhandled" };

		if (input.key === "escape") {
			this.#dismissedKey = key;
			this.#request = undefined;
			this.#invalidate();
			return { type: "handled" };
		}
		if (input.key === "up" || input.key === "down") {
			if (request.paths.length > 0) {
				const delta = input.key === "up" ? -1 : 1;
				request.selectedIndex = (request.selectedIndex + delta + request.paths.length) % request.paths.length;
				this.#invalidate();
			}
			return { type: "handled" };
		}
		if (input.shift || request.paths.length === 0) return { type: "unhandled" };

		const selectedPath = request.paths[request.selectedIndex]!;
		const token = `@${selectedPath}`;
		const replacementEnd = this.#editor.text[query.range.end] === " " ? query.range.end + 1 : query.range.end;
		this.#editor.replaceRange(query.range.start, replacementEnd, `${token} `);
		this.#editor.addMarker({
			id: `file-mention:${++this.#nextMarkerId}`,
			start: query.range.start,
			end: query.range.start + token.length,
			value: FILE_MENTION_MARKER_KIND,
		});
		this.#clearActiveMention();
		this.#dismissedKey = undefined;
		this.#invalidate();
		return { type: "handled" };
	}

	#activeQuery(): FileMentionQuery | undefined {
		const query = parseFileMentionQuery(this.#editor.text, this.#editor.cursorOffset);
		if (!query) return undefined;
		return this.#editor.markers.some(
			(marker) => marker.start === query.range.start && marker.value === FILE_MENTION_MARKER_KIND,
		)
			? undefined
			: query;
	}

	#clearActiveMention(): void {
		this.#searchSession = undefined;
		this.#mentionStart = undefined;
		this.#request = undefined;
	}

	#queryKey(): string {
		return `${this.#editor.text}\u0000${this.#editor.cursorOffset}`;
	}
}

function sanitizePaths(paths: readonly string[]): readonly string[] {
	const unique = new Set<string>();
	for (const path of paths) {
		if (path.length === 0 || /[\r\n\0]/u.test(path)) continue;
		unique.add(path);
	}
	return Object.freeze([...unique]);
}

function isFileMentionPaletteKey(key: string): key is "tab" | "enter" | "up" | "down" | "escape" {
	return key === "tab" || key === "enter" || key === "up" || key === "down" || key === "escape";
}

export function renderFileMentionPalette(
	palette: FileMentionPalette,
	width: number,
	maxItems: number,
	theme: TuiTheme,
): readonly string[] {
	const emptyMessage =
		palette.status === "loading"
			? "Searching workspace files…"
			: palette.status === "error"
				? "Workspace file search unavailable"
				: "No matching files";
	return renderCommandList(
		palette.items.map((item) => ({
			primary: `@${item.path}`,
			selected: item.selected,
		})),
		width,
		maxItems,
		theme,
		emptyMessage,
	);
}
