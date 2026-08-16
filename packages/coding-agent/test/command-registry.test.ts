import { describe, expect, it } from "vitest";
import { CommandRegistry } from "../src/commands/registry.ts";
import type { CommandDefinition, CommandSource } from "../src/commands/types.ts";

describe("CommandRegistry", () => {
	it("ranks case-insensitive prefixes before fuzzy matches without collapsing same-name sources", () => {
		const registry = new CommandRegistry();
		registry.register(command("core:model", "model", "core"));
		registry.register(command("skill:model", "model", "skill"));
		registry.register(command("mcp:module", "module", "mcp"));
		registry.register(command("skill:my-old-data", "my-old-data", "skill"));

		expect(registry.search("MO").map(({ command: match, kind }) => [match.id, kind])).toEqual([
			["core:model", "prefix"],
			["skill:model", "prefix"],
			["mcp:module", "prefix"],
			["skill:my-old-data", "fuzzy"],
		]);
	});

	it("excludes Core commands from an inline Extension query", () => {
		const registry = new CommandRegistry();
		registry.register(command("core:inspect", "inspect", "core"));
		registry.register(command("skill:inspect", "inspect", "skill"));

		expect(
			registry.search("inspect", { location: "token_boundary", trigger: "$" }).map(({ command: match }) => match.id),
		).toEqual(["skill:inspect"]);
	});

	it("keeps Skill mentions out of Slash queries", () => {
		const registry = new CommandRegistry();
		registry.register(command("core:model", "model", "core"));
		registry.register(command("skill:model", "model", "skill"));
		registry.register(command("mcp:module", "module", "mcp"));

		expect(
			registry.search("mo", { location: "composer_start", trigger: "/" }).map(({ command: match }) => match.id),
		).toEqual(["core:model", "mcp:module"]);
		expect(
			registry.search("mo", { location: "composer_start", trigger: "$" }).map(({ command: match }) => match.id),
		).toEqual(["skill:model"]);
	});
});

function command(id: string, name: string, source: CommandSource): CommandDefinition {
	return {
		id,
		name,
		title: name,
		source,
		kind: source === "core" ? "control" : "extension",
		triggerScope: source === "core" ? "composer_start" : "token_boundary",
		arguments: { kind: "none" },
	};
}
