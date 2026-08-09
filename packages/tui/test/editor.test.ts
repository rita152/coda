import { describe, expect, it } from "vitest";
import { Editor, type KeyInput, stripAnsi } from "../src/index.ts";

describe("Editor", () => {
	it("renders an empty full-width prompt and exposes its cursor placement", () => {
		const editor = new Editor();

		const frame = editor.render({
			width: 8,
			height: 20,
			focused: true,
			cursorMode: "software",
			styleBorder: (value) => `\x1b[35m${value}\x1b[0m`,
		});

		expect(frame.lines.map(stripAnsi)).toEqual(["────────", " ", "────────"]);
		expect(frame.lines[1]).toBe("\x1b[7m \x1b[27m");
		expect(frame.cursor).toEqual({ row: 1, column: 0, visible: false });
	});

	it("moves and deletes at grapheme boundaries", () => {
		const editor = new Editor();
		editor.handleInput({ type: "text", text: "a🙂b" });
		editor.handleInput(key("left"));
		editor.handleInput(key("backspace"));

		expect(editor.text).toBe("ab");
		const frame = editor.render({
			width: 8,
			height: 20,
			focused: true,
			cursorMode: "software",
			styleBorder: (value) => value,
		});
		expect(frame.lines[1]).toBe("a\x1b[7mb\x1b[27m");
		expect(frame.cursor).toEqual({ row: 1, column: 1, visible: false });
	});

	it("inserts a logical line with Shift+Enter and reports plain Enter as a submission", () => {
		const editor = new Editor();
		editor.handleInput({ type: "text", text: "first" });
		expect(editor.handleInput(key("enter", { shift: true }))).toEqual({ type: "handled" });
		editor.handleInput({ type: "text", text: "second" });

		expect(editor.text).toBe("first\nsecond");
		expect(editor.handleInput(key("enter"))).toEqual({ type: "submit", text: "first\nsecond" });
		expect(editor.text).toBe("first\nsecond");
	});

	it("places the end-of-line cursor on a new visual row at the exact wrap boundary", () => {
		const editor = new Editor();
		editor.handleInput({ type: "text", text: "abcde" });

		const frame = editor.render({
			width: 5,
			height: 20,
			focused: true,
			cursorMode: "software",
			styleBorder: (value) => value,
		});

		expect(frame.lines.map(stripAnsi)).toEqual(["─────", "abcde", " ", "─────"]);
		expect(frame.cursor).toEqual({ row: 2, column: 0, visible: false });
	});

	it("reserves prefix width for wrapping and cursor placement", () => {
		const editor = new Editor();
		editor.handleInput({ type: "text", text: "abcdef" });

		const frame = editor.render({
			width: 6,
			height: 20,
			focused: true,
			cursorMode: "native",
			styleBorder: (value) => value,
			prefix: "\x1b[1;31m! \x1b[0m",
		});

		expect(frame.lines.slice(1, -1).map(stripAnsi)).toEqual(["! abcd", "  ef"]);
		expect(frame.cursor).toEqual({ row: 2, column: 4, visible: true });
	});

	it("removes an absorbed prefix while preserving the logical cursor position", () => {
		const editor = new Editor();
		editor.setText("command");
		editor.handleInput(key("home"));
		editor.handleInput({ type: "text", text: "!" });

		expect(editor.absorbPrefix("!")).toBe(true);
		editor.handleInput({ type: "text", text: "x" });
		expect(editor.text).toBe("xcommand");
	});

	it("keeps the cursor visible and reports hidden visual rows in the border", () => {
		const editor = new Editor();
		editor.handleInput({ type: "text", text: "one\ntwo\nthree\nfour\nfive\nsix\nseven" });

		const frame = editor.render({
			width: 16,
			height: 10,
			focused: true,
			cursorMode: "native",
			styleBorder: (value) => value,
		});

		expect(frame.lines[0]).toContain("↑ 2 more");
		expect(frame.lines.slice(1, -1)).toEqual(["three", "four", "five", "six", "seven"]);
		expect(frame.cursor).toEqual({ row: 5, column: 5, visible: true });
	});

	it("folds a large normalized paste into an atomic marker and expands it for submission", () => {
		const editor = new Editor();
		const pasted = Array.from({ length: 11 }, (_, index) => `line\t${index + 1}`).join("\r\n");
		editor.handleInput({ type: "paste", text: `\x1b[2J${pasted}\x07` });

		expect(editor.text).toBe("[paste #1 +11 lines]");
		expect(editor.handleInput(key("enter"))).toEqual({
			type: "submit",
			text: pasted.replaceAll("\r\n", "\n").replaceAll("\t", "    "),
		});

		editor.handleInput(key("backspace"));
		expect(editor.text).toBe("");
		editor.handleInput(key("hyphen", { control: true }));
		expect(editor.text).toBe("[paste #1 +11 lines]");
	});

	it("uses logical-line Home and End while forward-delete removes one grapheme", () => {
		const editor = new Editor();
		editor.handleInput({ type: "text", text: "first\n🙂ab" });
		editor.handleInput(key("home"));
		editor.handleInput(key("delete"));
		expect(editor.text).toBe("first\nab");

		editor.handleInput(key("end"));
		const frame = editor.render({
			width: 10,
			height: 20,
			focused: true,
			cursorMode: "native",
			styleBorder: (value) => value,
		});
		expect(frame.cursor).toEqual({ row: 2, column: 2, visible: true });
	});

	it("moves by words and yanks text deleted into the kill ring", () => {
		const editor = new Editor();
		editor.handleInput({ type: "text", text: "alpha beta" });
		editor.handleInput(key("left", { control: true }));
		editor.handleInput(key("backspace", { alt: true }));
		expect(editor.text).toBe("beta");

		editor.handleInput(key("y", { control: true }));
		expect(editor.text).toBe("alpha beta");
	});

	it("moves across wrapped visual rows while preserving the preferred column", () => {
		const editor = new Editor();
		editor.handleInput({ type: "text", text: "abcdef\nxy\nabcdef" });
		const render = () =>
			editor.render({
				width: 4,
				height: 20,
				focused: true,
				cursorMode: "native",
				styleBorder: (value) => value,
			});
		render();

		editor.handleInput(key("up"));
		editor.handleInput(key("up"));
		expect(render().cursor).toEqual({ row: 3, column: 2, visible: true });
		editor.handleInput(key("up"));
		editor.handleInput(key("up"));
		expect(render().cursor).toEqual({ row: 1, column: 2, visible: true });
	});

	it("reports visual movement boundaries using the rendered content width", () => {
		const editor = new Editor();
		editor.handleInput({ type: "text", text: "你🙂abc" });
		editor.render({
			width: 6,
			height: 20,
			focused: true,
			cursorMode: "native",
			styleBorder: (value) => value,
			prefix: "! ",
		});

		expect(editor.canMoveVertical(-1)).toBe(true);
		expect(editor.canMoveVertical(1)).toBe(false);
		editor.handleInput(key("up"));
		expect(editor.canMoveVertical(-1)).toBe(false);
		expect(editor.canMoveVertical(1)).toBe(true);
	});

	it("captures and restores an exact editing state", () => {
		const editor = new Editor();
		editor.handleInput({ type: "text", text: "first\nsecond" });
		editor.render({
			width: 12,
			height: 20,
			focused: true,
			cursorMode: "native",
			styleBorder: (value) => value,
		});
		editor.handleInput(key("up"));
		const state = editor.captureState();
		const expectedCursor = editor.render({
			width: 12,
			height: 20,
			focused: true,
			cursorMode: "native",
			styleBorder: (value) => value,
		}).cursor;

		editor.setText("replacement");
		editor.restoreState(state);

		expect(editor.text).toBe("first\nsecond");
		expect(
			editor.render({
				width: 12,
				height: 20,
				focused: true,
				cursorMode: "native",
				styleBorder: (value) => value,
			}).cursor,
		).toEqual(expectedCursor);
	});

	it("word-wraps before hard-wrapping an overlong grapheme sequence", () => {
		const editor = new Editor();
		editor.handleInput({ type: "text", text: "one two" });
		const frame = editor.render({
			width: 5,
			height: 20,
			focused: true,
			cursorMode: "native",
			styleBorder: (value) => value,
		});

		expect(frame.lines.slice(1, -1).map((line) => stripAnsi(line).trimEnd())).toEqual(["one", "two"]);
		expect(frame.cursor).toEqual({ row: 2, column: 3, visible: true });
	});

	it("supports backslash-newline fallback and reports Alt+Enter as an alternate submission", () => {
		const editor = new Editor();
		editor.handleInput({ type: "text", text: "line\\" });
		expect(editor.handleInput(key("enter"))).toEqual({ type: "handled" });
		editor.handleInput({ type: "text", text: "next" });

		expect(editor.text).toBe("line\nnext");
		expect(editor.handleInput(key("enter", { alt: true }))).toEqual({
			type: "submit",
			text: "line\nnext",
			alternate: true,
		});
	});

	it("supports Emacs line movement, kill, yank, and yank rotation", () => {
		const editor = new Editor();
		editor.handleInput({ type: "text", text: "alpha beta\ngamma delta" });
		editor.handleInput(key("a", { control: true }));
		editor.handleInput(key("k", { control: true }));
		expect(editor.text).toBe("alpha beta\n");

		editor.handleInput(key("b", { control: true }));
		editor.handleInput(key("u", { control: true }));
		expect(editor.text).toBe("\n");
		editor.handleInput(key("y", { control: true }));
		expect(editor.text).toBe("alpha beta\n");
		editor.handleInput(key("y", { alt: true }));
		expect(editor.text).toBe("gamma delta\n");

		editor.handleInput(key("b", { control: true }));
		editor.handleInput(key("e", { control: true }));
		expect(editor.handleInput(key("enter"))).toEqual({ type: "submit", text: "gamma delta" });
	});

	it("deletes the next word with Alt+D and pages through visual rows", () => {
		const editor = new Editor();
		editor.handleInput({ type: "text", text: "one two three four five six seven" });
		editor.render({
			width: 5,
			height: 10,
			focused: true,
			cursorMode: "native",
			styleBorder: (value) => value,
		});
		editor.handleInput(key("left", { control: true }));
		editor.handleInput(key("d", { alt: true }));
		expect(editor.text).toBe("one two three four five six ");
		editor.handleInput(key("page-up", { control: true }));
		const frame = editor.render({
			width: 5,
			height: 10,
			focused: true,
			cursorMode: "native",
			styleBorder: (value) => value,
		});
		expect(frame.cursor?.row).toBe(1);
	});
});

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
