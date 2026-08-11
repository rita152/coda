import { describe, expect, it, vi } from "vitest";
import { createSkillSelectionCommandFlow, createSkillsCommandFlow } from "../src/commands/skills-flow.ts";

describe("Skills command flow", () => {
	it("selects a discovered Skill for Composer insertion without opening its tool details", () => {
		const snapshot = {
			candidates: [],
			resolved: [
				{
					candidate: {
						id: "skill:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
						metadata: { name: "review", description: "Review workflow" },
					},
					qualifiedName: "review",
					origin: { scope: "user", root: "/home/.agents/skills", priority: 1 },
					precedence: 1,
					sourceLabel: "~/.agents/skills",
					winner: true,
					collisionCount: 1,
				},
			],
		} as never;
		const onSelect = vi.fn();
		const flow = createSkillSelectionCommandFlow({ snapshot, onSelect });

		expect(flow.items).toHaveLength(1);
		expect(flow.items[0]).toMatchObject({ label: "$review" });
		flow.items[0]!.onSelect!({ push: vi.fn(), back: vi.fn(), close: vi.fn() });
		expect(onSelect).toHaveBeenCalledWith("skill:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", expect.anything());
	});

	it("shows project Skills directly without a trust gate", () => {
		const snapshot = {
			candidates: [],
			resolved: [
				{
					candidate: {
						id: "skill:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
						metadata: { name: "review", description: "Review workflow" },
					},
					qualifiedName: "review",
					origin: { scope: "workspace", root: "/workspace/.agents/skills", priority: 0 },
					precedence: 0,
					sourceLabel: "./.agents/skills",
					winner: true,
					collisionCount: 1,
				},
			],
		} as never;
		const flow = createSkillSelectionCommandFlow({ snapshot, onSelect: vi.fn() });

		expect(flow.items).toEqual([
			expect.objectContaining({ id: "skill:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", label: "$review" }),
		]);
		expect(flow.items[0]!.disabledReason).toBeUndefined();
	});

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
