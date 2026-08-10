import { describe, expect, it, vi } from "vitest";
import { createSkillsCommandFlow } from "../src/commands/skills-flow.ts";

describe("Skills command flow", () => {
	it("shows inventory trust, refresh, trust review, and candidate status", () => {
		const snapshot = {
			inventory: {
				trust: "untrusted",
				sha256: "a".repeat(64),
				items: [{ id: "skill:a", path: "/workspace/SKILL.md", revision: "r" }],
				diff: {
					added: [{ id: "skill:a", path: "/workspace/SKILL.md", revision: "r" }],
					removed: [],
					changed: [],
				},
			},
			candidates: [
				{
					id: "skill:a",
					metadata: { name: "review" },
					skillFile: "/workspace/SKILL.md",
				},
			],
			admitted: [],
			byId: new Map(),
			diagnostics: [
				{ code: "workspace-skills-untrusted", severity: "warning", message: "Workspace Skills were omitted" },
			],
		} as never;
		const flow = createSkillsCommandFlow({
			snapshot,
			onRefresh: vi.fn(),
			onTrust: vi.fn(),
		});

		expect(flow.items.map(({ id }) => id)).toEqual(["inventory", "diagnostics", "refresh", "trust", "skill:a"]);
		expect(flow.items[0]!.label).toContain("untrusted");
		expect(flow.items.at(-1)!.status).toBe("omitted");
		const push = vi.fn();
		flow.items[1]!.onSelect!({ push, back: vi.fn(), close: vi.fn() });
		expect(push).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "skills:diagnostics",
				items: [expect.objectContaining({ label: "warning: workspace-skills-untrusted" })],
			}),
		);
	});
});
