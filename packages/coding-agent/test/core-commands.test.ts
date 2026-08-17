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
			"mcp",
			"hooks",
			"session",
			"new",
			"follow-up",
		]);
		expect(resolveCommandInvocation(registry, "/skill")).toBeUndefined();
		expect(resolveCommandInvocation(registry, "/effort")?.command.id).toBe("core:effort");
		expect(resolveCommandInvocation(registry, "/skills")?.command.id).toBe("core:skills");
		expect(resolveCommandInvocation(registry, "/legacy")).toBeUndefined();
		expect(resolveCommandInvocation(registry, "/attach image.png")).toBeUndefined();
	});

	it("offers /skills in completion as the only Skill command entry", () => {
		const registry = createCoreCommandRegistry();

		expect(registry.search("ski").map(({ command }) => command.name)).toEqual(["skills"]);
		expect(resolveCommandInvocation(registry, "/skills")?.command.id).toBe("core:skills");
	});
});
