import { Editor, type KeyInput, stripAnsi } from "@coda/tui";
import { describe, expect, it } from "vitest";
import { CommandRegistry } from "../src/commands/registry.ts";
import type { CommandDefinition } from "../src/commands/types.ts";
import { CommandComposer, renderCommandPalette } from "../src/interactive/command-composer.ts";
import { createCodaTheme } from "../src/interactive/theme.ts";

describe("CommandComposer", () => {
	it("exposes ranked palette items with an explicit source tag", () => {
		const registry = new CommandRegistry();
		registry.register(command({ id: "skill:model", name: "model", source: "skill" }));
		registry.register(command({ id: "core:model", name: "model", source: "core" }));
		const editor = new Editor();
		editor.setText("/mo");

		const composer = new CommandComposer(registry, editor);

		expect(composer.palette?.items).toEqual([
			{
				commandId: "core:model",
				label: "/model",
				sourceTag: "<core>",
				title: "model",
				selected: true,
			},
			{
				commandId: "skill:model",
				label: "/model",
				sourceTag: "<skill>",
				title: "model",
				selected: false,
			},
		]);
	});

	it("completes the highlighted command token with Tab", () => {
		const registry = new CommandRegistry();
		registry.register(command({ id: "core:model", name: "model", source: "core" }));
		const editor = new Editor();
		editor.setText("/mo");
		const composer = new CommandComposer(registry, editor);

		expect(composer.handleInput(key("tab"))).toEqual({ type: "handled" });
		expect(editor.text).toBe("/model");
		expect(editor.cursorOffset).toBe(6);
	});

	it("keeps a same-name Extension selection after Tab and inserts its reference only on Enter", () => {
		const registry = new CommandRegistry();
		registry.register(command({ id: "core:model", name: "model", source: "core" }));
		registry.register(command({ id: "skill:model", name: "model", source: "skill" }));
		const editor = new Editor();
		editor.setText("/mo");
		const composer = new CommandComposer(registry, editor);
		composer.handleInput(key("down"));

		expect(composer.handleInput(key("tab"))).toEqual({ type: "handled" });
		expect(editor.text).toBe("/model");
		expect(composer.extensionReferences).toEqual([]);
		expect(composer.palette?.items.find(({ selected }) => selected)?.commandId).toBe("skill:model");

		expect(composer.handleInput(key("enter"))).toEqual({ type: "handled" });
		expect(composer.extensionReferences).toMatchObject([{ commandId: "skill:model", source: "skill" }]);
	});

	it("returns the highlighted core command on Enter without submitting prompt text", () => {
		const registry = new CommandRegistry();
		registry.register(command({ id: "core:model", name: "model", source: "core" }));
		const editor = new Editor();
		editor.setText("/mo");
		const composer = new CommandComposer(registry, editor);

		expect(composer.handleInput(key("enter"))).toMatchObject({
			type: "invoke",
			command: { id: "core:model" },
		});
		expect(editor.text).toBe("/mo");
	});

	it("inserts an extension reference on Enter and keeps the Composer open", () => {
		const registry = new CommandRegistry();
		registry.register(command({ id: "core:review", name: "review", source: "core" }));
		registry.register(command({ id: "skill:review", name: "review", source: "skill" }));
		const editor = new Editor();
		editor.setText("Please /rev");
		const composer = new CommandComposer(registry, editor);
		composer.handleInput(key("down"));

		expect(composer.handleInput(key("enter"))).toEqual({ type: "handled" });
		expect(editor.text).toBe("Please /review ");
		expect(editor.cursorOffset).toBe(editor.text.length);
		expect(composer.extensionReferences).toEqual([
			{
				id: expect.stringMatching(/^extension-reference:/u),
				commandId: "skill:review",
				source: "skill",
				name: "review",
				start: 7,
				end: 14,
			},
		]);
	});

	it("inserts a selected Skill as a Codex-style $ mention with a structured reference", () => {
		const registry = new CommandRegistry();
		registry.register(command({ id: "skill:review", name: "review", source: "skill" }));
		const editor = new Editor();
		const composer = new CommandComposer(registry, editor);

		composer.insertSkillReference("skill:review");

		expect(editor.text).toBe("$review ");
		expect(composer.extensionReferences).toMatchObject([
			{
				commandId: "skill:review",
				source: "skill",
				name: "review",
				start: 0,
				end: "$review".length,
			},
		]);
	});

	it("invalidates an edited extension token and restores its identity on undo", () => {
		const registry = new CommandRegistry();
		registry.register(command({ id: "skill:review", name: "review", source: "skill" }));
		const editor = new Editor();
		editor.setText("/rev");
		const composer = new CommandComposer(registry, editor);
		composer.handleInput(key("enter"));
		const reference = composer.extensionReferences[0]!;

		editor.handleInput(key("left"));
		editor.handleInput(key("left"));
		editor.handleInput(key("backspace"));
		expect(composer.extensionReferences).toEqual([]);

		editor.handleInput(key("hyphen", { control: true }));
		expect(composer.extensionReferences).toEqual([reference]);
	});

	it("preserves the textual order of multiple extension references", () => {
		const registry = new CommandRegistry();
		registry.register(command({ id: "skill:review", name: "review", source: "skill" }));
		registry.register(command({ id: "mcp:search", name: "search", source: "mcp" }));
		const editor = new Editor();
		editor.setText("Use /rev");
		const composer = new CommandComposer(registry, editor);
		composer.handleInput(key("enter"));
		editor.handleInput({ type: "text", text: "then /sea" });
		composer.handleInput(key("enter"));

		expect(composer.extensionReferences.map(({ commandId, start, end }) => ({ commandId, start, end }))).toEqual([
			{ commandId: "skill:review", start: 4, end: 11 },
			{ commandId: "mcp:search", start: 17, end: 24 },
		]);
	});

	it("remembers a selected same-name extension as a raw prompt instead of invoking core", () => {
		const registry = new CommandRegistry();
		registry.register(command({ id: "core:model", name: "model", source: "core" }));
		registry.register(command({ id: "skill:model", name: "model", source: "skill" }));
		const editor = new Editor();
		editor.setText("/mo");
		const composer = new CommandComposer(registry, editor);

		composer.handleInput(key("down"));
		composer.handleInput(key("enter"));

		expect(editor.text).toBe("/model ");
		expect(composer.resolveSubmission("/model")).toBeUndefined();
	});

	it("moves the highlighted palette item with arrow keys", () => {
		const registry = new CommandRegistry();
		registry.register(command({ id: "core:model", name: "model", source: "core" }));
		registry.register(command({ id: "skill:model", name: "model", source: "skill" }));
		const editor = new Editor();
		editor.setText("/mo");
		const composer = new CommandComposer(registry, editor);

		expect(composer.handleInput(key("down"))).toEqual({ type: "handled" });
		expect(composer.palette?.items.map(({ commandId, selected }) => ({ commandId, selected }))).toEqual([
			{ commandId: "core:model", selected: false },
			{ commandId: "skill:model", selected: true },
		]);
	});

	it("dismisses the palette with Escape while preserving raw prompt text", () => {
		const registry = new CommandRegistry();
		registry.register(command({ id: "core:model", name: "model", source: "core" }));
		const editor = new Editor();
		editor.setText("/mo");
		const composer = new CommandComposer(registry, editor);
		expect(composer.palette).toBeDefined();

		expect(composer.handleInput(key("escape"))).toEqual({ type: "handled" });

		expect(editor.text).toBe("/mo");
		expect(composer.palette).toBeUndefined();
		editor.handleInput({ type: "text", text: "d" });
		expect(composer.palette).toBeDefined();
	});

	it("renders the candidate list as a borderless Pi-style upper list", () => {
		const registry = new CommandRegistry();
		registry.register(command({ id: "core:model", name: "model", source: "core" }));
		const editor = new Editor();
		editor.setText("/mo");
		const composer = new CommandComposer(registry, editor);

		const rendered = renderCommandPalette(composer.palette!, 48, 6, createCodaTheme(0)).map(stripAnsi);

		expect(rendered).toEqual(["→ /model <core>  model"]);
		expect(rendered.join("\n")).not.toMatch(/[╭╮╰╯│]/u);
	});

	it("adds Pi-style position information only when the candidate list is clipped", () => {
		const registry = new CommandRegistry();
		for (const name of ["alpha", "beta", "gamma", "delta"]) {
			registry.register(command({ id: `core:${name}`, name, source: "core" }));
		}
		const editor = new Editor();
		editor.setText("/");
		const composer = new CommandComposer(registry, editor);

		const rendered = renderCommandPalette(composer.palette!, 48, 2, createCodaTheme(0)).map(stripAnsi);

		expect(rendered).toHaveLength(3);
		expect(rendered.at(-1)).toBe("  (1/4)");
	});
});

function command(overrides: Pick<CommandDefinition, "id" | "name" | "source">): CommandDefinition {
	return Object.freeze({
		...overrides,
		title: overrides.name,
		kind: overrides.source === "core" ? "control" : "extension",
		triggerScope: overrides.source === "core" ? "composer_start" : "token_boundary",
		arguments: { kind: "none" } as const,
	});
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
