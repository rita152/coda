import { Editor } from "@coda/tui";
import { describe, expect, it } from "vitest";
import { ComposerHistory } from "../src/interactive/composer-history.ts";

describe("ComposerHistory", () => {
	it("enters history only at the first visual row and restores the exact draft past newest", () => {
		const history = new ComposerHistory([
			{ id: "submission:1", kind: "prompt", text: "older" },
			{ id: "submission:2", kind: "steering", text: "newer\nsecond line" },
		]);
		const editor = new Editor();
		editor.setText("draft\nwith cursor here");
		render(editor, 12);

		expect(history.navigate(-1, editor)).toBe(false);
		while (editor.canMoveVertical(-1)) editor.handleInput(key("up"));
		expect(history.navigate(-1, editor)).toBe(true);
		expect(editor.text).toBe("newer\nsecond line");

		render(editor, 12);
		expect(history.navigate(-1, editor)).toBe(false);
		editor.handleInput(key("up"));
		expect(history.navigate(-1, editor)).toBe(true);
		expect(editor.text).toBe("older");

		render(editor, 12);
		expect(history.navigate(1, editor)).toBe(true);
		expect(editor.text).toBe("newer\nsecond line");
		render(editor, 12);
		expect(history.navigate(1, editor)).toBe(true);
		expect(editor.text).toBe("draft\nwith cursor here");
	});

	it("keeps history immutable after editing a recalled value", () => {
		const history = new ComposerHistory([{ id: "submission:1", kind: "prompt", text: "original" }]);
		const editor = new Editor();
		render(editor, 20);
		history.navigate(-1, editor);
		editor.handleInput({ type: "text", text: " edited" });
		history.noteTextMutation();
		render(editor, 20);

		expect(history.navigate(-1, editor)).toBe(true);
		expect(editor.text).toBe("original");
	});

	it("collapses adjacent duplicate text and removes retracted submissions", () => {
		const history = new ComposerHistory([
			{ id: "submission:1", kind: "prompt", text: "same" },
			{ id: "submission:2", kind: "follow_up", text: "same", queueItemId: "queue:2" },
			{ id: "submission:3", kind: "prompt", text: "last" },
		]);
		history.retractByQueueItemId("queue:2");
		history.retract("submission:3");
		const editor = new Editor();
		render(editor, 20);

		expect(history.navigate(-1, editor)).toBe(true);
		expect(editor.text).toBe("same");
		render(editor, 20);
		expect(history.navigate(-1, editor)).toBe(true);
		expect(editor.text).toBe("same");
	});
});

function render(editor: Editor, width: number): void {
	editor.render({
		width,
		height: 20,
		focused: true,
		cursorMode: "native",
		styleBorder: (value) => value,
	});
}

function key(keyName: "up" | "down") {
	return {
		type: "key" as const,
		key: keyName,
		shift: false,
		control: false,
		alt: false,
		meta: false,
		action: "press" as const,
	};
}
