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
			"skill",
			"mcp",
			"session",
			"new",
			"follow-up",
		]);
		expect(resolveCommandInvocation(registry, "/skill")?.command.id).toBe("core:skill");
		expect(resolveCommandInvocation(registry, "/effort")?.command.id).toBe("core:effort");
		expect(resolveCommandInvocation(registry, "/skills")?.command.id).toBe("core:skills");
		expect(resolveCommandInvocation(registry, "/legacy")).toBeUndefined();
		expect(resolveCommandInvocation(registry, "/attach image.png")).toBeUndefined();
	});

	it("keeps the Skills management command out of the /skill picker while preserving exact access", () => {
		const registry = createCoreCommandRegistry();

		expect(registry.search("skill").map(({ command }) => command.name)).toEqual(["skill"]);
		expect(resolveCommandInvocation(registry, "/skills")?.command.id).toBe("core:skills");
	});
});
