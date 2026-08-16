import { describe, expect, it, vi } from "vitest";
import { createSkillsCommandFlow } from "../src/commands/skills-flow.ts";

describe("Skills command flow", () => {
	it("shows diagnostics, refresh, and every discovered Skill", () => {
		const snapshot = {
			candidates: [],
			resolved: [
				{
					candidate: {
						id: "skill:a",
						metadata: { name: "review" },
						conformant: true,
						diagnostics: [],
						skillFile: "/workspace/SKILL.md",
						revision: "r",
					},
					qualifiedName: "review",
					origin: { scope: "workspace", root: "/workspace/.agents/skills", priority: 0 },
					precedence: 0,
					sourceLabel: "./.agents/skills",
					winner: true,
					collisionCount: 1,
				},
			],
			diagnostics: [{ code: "unknown-field", severity: "warning", message: "Ignored field" }],
		} as never;
		const flow = createSkillsCommandFlow({ snapshot, onRefresh: vi.fn() });

		expect(flow.items.map(({ id }) => id)).toEqual(["diagnostics", "refresh", "skill:a"]);
		expect(flow.items.at(-1)!.status).toBe("available");
		const push = vi.fn();
		flow.items[0]!.onSelect!({ push, back: vi.fn(), close: vi.fn() });
		expect(push).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "skills:diagnostics",
				items: [expect.objectContaining({ label: "warning: unknown-field" })],
			}),
		);
	});
});
