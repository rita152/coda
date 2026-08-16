import { Editor, type KeyInput, stripAnsi } from "@coda/tui";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceFileSearch, WorkspaceFileSearchSession } from "../src/host/workspace-file-search.ts";
import {
	FileMentionComposer,
	parseFileMentionQuery,
	renderFileMentionPalette,
} from "../src/ui/file-mention-composer.ts";
import { createCodaTheme } from "../src/ui/theme.ts";

describe("file mention query", () => {
	it("activates only at the start of an empty Composer or after an ASCII space", () => {
		expect(parseFileMentionQuery("@src", 4)).toEqual({ query: "src", range: { start: 0, end: 4 } });
		expect(parseFileMentionQuery("Review @src", 11)).toEqual({ query: "src", range: { start: 7, end: 11 } });
		expect(parseFileMentionQuery("Review@src", 10)).toBeUndefined();
		expect(parseFileMentionQuery("Review\n@src", 11)).toBeUndefined();
		expect(parseFileMentionQuery("Review\t@src", 11)).toBeUndefined();
	});

	it("keeps spaces inside a file-name query", () => {
		expect(parseFileMentionQuery("@My F", 5)).toEqual({ query: "My F", range: { start: 0, end: 5 } });
		expect(parseFileMentionQuery("Review @My F", 12)).toEqual({ query: "My F", range: { start: 7, end: 12 } });
	});

	it("does not activate in the middle of an existing token", () => {
		expect(parseFileMentionQuery("@source.ts", 4)).toBeUndefined();
	});
});

describe("FileMentionComposer", () => {
	it("completes a leading file mention with Tab and appends one space", async () => {
		const editor = new Editor();
		editor.setText("@ma");
		const composer = new FileMentionComposer(
			editor,
			fileSearch(async () => ["src/main.ts"]),
			{
				invalidate: vi.fn(),
			},
		);
		await vi.waitFor(() => expect(composer.palette?.items).toHaveLength(1));
		expect(composer.handleInput(key("tab"))).toEqual({ type: "handled" });
		expect(editor.text).toBe("@src/main.ts ");
		expect(editor.cursorOffset).toBe(editor.text.length);
	});

	it("replaces an inline query on Enter and preserves the preceding prompt", async () => {
		const editor = new Editor();
		editor.setText("Review @ma");
		const composer = new FileMentionComposer(
			editor,
			fileSearch(async () => ["src/main.ts"]),
			{
				invalidate: vi.fn(),
			},
		);
		await vi.waitFor(() => expect(composer.palette?.items).toHaveLength(1));
		expect(composer.handleInput(key("enter"))).toEqual({ type: "handled" });
		expect(editor.text).toBe("Review @src/main.ts ");
	});

	it("completes file names containing spaces without reopening the completed mention", async () => {
		const editor = new Editor();
		editor.setText("@My F");
		const composer = new FileMentionComposer(
			editor,
			fileSearch(async () => ["My File.ts"]),
			{
				invalidate: vi.fn(),
			},
		);
		await vi.waitFor(() => expect(composer.palette?.items).toHaveLength(1));
		expect(composer.handleInput(key("tab"))).toEqual({ type: "handled" });
		expect(editor.text).toBe("@My File.ts ");
		expect(composer.palette).toBeUndefined();
	});

	it("consumes existing spaces after an inline query before appending one space", async () => {
		const editor = new Editor();
		editor.setText("Review @ma carefully");
		for (let index = 0; index < " carefully".length; index++) editor.handleInput(key("left"));
		const composer = new FileMentionComposer(
			editor,
			fileSearch(async () => ["src/main.ts"]),
			{
				invalidate: vi.fn(),
			},
		);
		await vi.waitFor(() => expect(composer.palette?.items).toHaveLength(1));
		expect(composer.handleInput(key("enter"))).toEqual({ type: "handled" });
		expect(editor.text).toBe("Review @src/main.ts carefully");
	});

	it("moves the selected file and dismisses the palette without changing text", async () => {
		const editor = new Editor();
		editor.setText("@");
		const composer = new FileMentionComposer(
			editor,
			fileSearch(async () => ["one.ts", "two.ts"]),
			{
				invalidate: vi.fn(),
			},
		);
		await vi.waitFor(() => expect(composer.palette?.items).toHaveLength(2));
		expect(composer.handleInput(key("down"))).toEqual({ type: "handled" });
		expect(composer.palette?.items.find(({ selected }) => selected)?.path).toBe("two.ts");
		expect(composer.handleInput(key("escape"))).toEqual({ type: "handled" });
		expect(editor.text).toBe("@");
		expect(composer.palette).toBeUndefined();
	});

	it("renders paths in the shared borderless candidate list", async () => {
		const editor = new Editor();
		editor.setText("@ma");
		const composer = new FileMentionComposer(
			editor,
			fileSearch(async () => ["src/main.ts"]),
			{
				invalidate: vi.fn(),
			},
		);
		await vi.waitFor(() => expect(composer.palette?.status).toBe("ready"));
		const rendered = renderFileMentionPalette(composer.palette!, 48, 6, createCodaTheme(0)).map(stripAnsi);
		expect(rendered).toEqual(["→ @src/main.ts"]);
	});
});

function fileSearch(search: WorkspaceFileSearchSession): WorkspaceFileSearch {
	return Object.freeze({ startSession: () => search });
}

function key(keyName: KeyInput["key"], overrides: Partial<KeyInput> = {}): KeyInput {
	return {
		type: "key",
		key: keyName,
		shift: false,
		control: false,
		alt: false,
		meta: false,
		action: "press",
		...overrides,
	};
}
