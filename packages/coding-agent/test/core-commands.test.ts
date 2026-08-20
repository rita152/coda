import { describe, expect, it } from "vitest";
import { createCoreCommandRegistry } from "../src/commands/core-commands.ts";
import { resolveCommandInvocation } from "../src/commands/parser.ts";

describe("core commands", () => {
	it("publishes the confirmed command surface", () => {
		const registry = createCoreCommandRegistry();

		expect(registry.search("").map(({ command }) => command.name)).toEqual([
			"auth",
			"model",
			"effort",
			"skills",
			"plugins",
			"mcp",
			"hooks",
			"permissions",
			"session",
			"cancel-work",
			"new",
			"follow-up",
		]);
		expect(resolveCommandInvocation(registry, "/skill")).toBeUndefined();
		expect(resolveCommandInvocation(registry, "/effort")?.command.id).toBe("core:effort");
		expect(resolveCommandInvocation(registry, "/permissions")?.command.id).toBe("core:permissions");
		expect(resolveCommandInvocation(registry, "/skills")?.command.id).toBe("core:skills");
		expect(resolveCommandInvocation(registry, "/plugins")?.command.id).toBe("core:plugins");
		expect(resolveCommandInvocation(registry, "/plugins review-tools@team")?.argument).toBe("review-tools@team");
		expect(resolveCommandInvocation(registry, "/legacy")).toBeUndefined();
		expect(resolveCommandInvocation(registry, "/attach image.png")).toBeUndefined();
	});

	it("offers only the plural /plugins management command with an optional selector", () => {
		const registry = createCoreCommandRegistry();

		expect(registry.search("plug").map(({ command }) => command.name)).toEqual(["plugins"]);
		expect(resolveCommandInvocation(registry, "/plugin")).toBeUndefined();
		expect(resolveCommandInvocation(registry, "/plugins")?.command.arguments).toEqual({
			kind: "tail",
			required: false,
		});
	});

	it("offers /skills in completion as the only Skill command entry", () => {
		const registry = createCoreCommandRegistry();

		expect(registry.search("ski").map(({ command }) => command.name)).toEqual(["skills"]);
		expect(resolveCommandInvocation(registry, "/skills")?.command.id).toBe("core:skills");
	});
});
