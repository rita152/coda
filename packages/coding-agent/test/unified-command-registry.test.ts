import { describe, expect, it } from "vitest";
import { createUnifiedCommandRegistry } from "../src/commands/unified-registry.ts";

describe("createUnifiedCommandRegistry", () => {
	it("combines core, Skill, and MCP entries without hiding same-name sources", () => {
		const registry = createUnifiedCommandRegistry({
			skills: [{ id: "review", name: "review", description: "Review this change" }],
			mcp: [{ id: "review", name: "review", title: "Remote review" }],
		});

		expect(registry.search("review", { location: "token_boundary" }).map(({ command }) => command)).toEqual([
			expect.objectContaining({ id: "skill:review", source: "skill", kind: "extension" }),
			expect.objectContaining({ id: "mcp:review", source: "mcp", kind: "extension" }),
		]);
		expect(registry.search("mo", { location: "composer_start" })[0]?.command.id).toBe("core:model");
	});
});
