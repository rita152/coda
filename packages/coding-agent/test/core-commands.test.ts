import { describe, expect, it } from "vitest";
import { createCoreCommandRegistry } from "../src/commands/core-commands.ts";
import { resolveCommandInvocation } from "../src/commands/parser.ts";

describe("core commands", () => {
	it("publishes the confirmed command surface and only keeps /permissions as a hidden alias", () => {
		const registry = createCoreCommandRegistry();

		expect(registry.search("").map(({ command }) => command.name)).toEqual([
			"permission",
			"auth",
			"model",
			"skills",
			"mcp",
			"session",
			"new",
			"follow-up",
		]);
		expect(resolveCommandInvocation(registry, "/permissions")?.command.id).toBe("core:permission");
		expect(resolveCommandInvocation(registry, "/approvals")).toBeUndefined();
		expect(resolveCommandInvocation(registry, "/attach image.png")).toBeUndefined();
	});
});
