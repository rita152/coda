import { describe, expect, it, vi } from "vitest";
import { createSkillsCommandFlow, createSkillTryNowPrefill } from "../src/commands/skills-flow.ts";

describe("Skills command flow", () => {
	it.each([
		{ winner: true, qualifiedName: "review@workspace-deadbeef", expected: "$review " },
		{ winner: false, qualifiedName: "review@user-feedface", expected: "$review@user-feedface " },
	])("uses the same direct Skill surface name as the Composer for winner=$winner", (example) => {
		const entry = {
			candidate: { id: "skill:a", metadata: { name: "review" } },
			qualifiedName: example.qualifiedName,
			origin: { scope: "workspace", root: "/workspace/.agents/skills", priority: 0, kind: "direct" },
			winner: example.winner,
		} as never;

		expect(createSkillTryNowPrefill(entry)).toMatchObject({
			text: example.expected,
			name: example.expected.trim().slice(1),
		});
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
		expect(flow.items.at(-1)!.label).toBe("review");
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

	it("uses canonical qualified names as the primary identity for same-named Plugin Skills", () => {
		const pluginEntry = (pluginName: string, id: string, displayName: string) => ({
			candidate: {
				id,
				metadata: { name: "review" },
				conformant: true,
				diagnostics: [],
				skillFile: `/plugins/${pluginName}/skills/review/SKILL.md`,
				revision: "r",
			},
			qualifiedName: `${pluginName}:review`,
			origin: {
				scope: "user",
				root: `/plugins/${pluginName}`,
				priority: 1,
				kind: "plugin",
				pluginName,
			},
			interface: { displayName, shortDescription: `Review with ${pluginName}` },
			precedence: 1,
			sourceLabel: `${pluginName}@team-market`,
			winner: pluginName === "alpha-tools",
			collisionCount: 2,
		});
		const snapshot = {
			candidates: [],
			resolved: [
				pluginEntry("alpha-tools", "skill:alpha", "Alpha review"),
				pluginEntry("beta-tools", "skill:beta", "Beta review"),
			],
			diagnostics: [],
		} as never;

		const flow = createSkillsCommandFlow({ snapshot, onRefresh: vi.fn() });
		const pluginItems = flow.items.slice(2);
		expect(pluginItems.map(({ label }) => label)).toEqual(["alpha-tools:review", "beta-tools:review"]);
		expect(pluginItems.map(({ description }) => description)).toEqual([
			expect.stringContaining("Alpha review"),
			expect.stringContaining("Beta review"),
		]);

		const push = vi.fn();
		pluginItems[0]!.onSelect!({ push, back: vi.fn(), close: vi.fn() });
		expect(push).toHaveBeenCalledWith(
			expect.objectContaining({
				title: "alpha-tools:review",
				items: expect.arrayContaining([
					expect.objectContaining({
						id: "name",
						description: "alpha-tools:review",
					}),
					expect.objectContaining({ id: "display-name", description: "Alpha review" }),
				]),
			}),
		);
	});

	it("offers a normalized non-submitting Try now prefill that qualifies Plugin Skill mentions", async () => {
		const onTry = vi.fn();
		const snapshot = {
			candidates: [],
			resolved: [
				{
					candidate: {
						id: "skill:a",
						metadata: { name: "review" },
						conformant: true,
						diagnostics: [],
						skillFile: "/workspace/.agents/plugins/review-tools/skills/review/SKILL.md",
						revision: "r",
					},
					qualifiedName: "review-tools:review",
					origin: {
						scope: "workspace",
						root: "/workspace/.agents/plugins/review-tools",
						priority: 1,
						kind: "plugin",
						pluginName: "review-tools",
					},
					interface: {
						displayName: "Plugin review helper",
						shortDescription: "Review the selected change through the Plugin",
						defaultPrompt: "First line Use $review now",
					},
					precedence: 1,
					sourceLabel: "review-tools@workspace-local",
					winner: true,
					collisionCount: 1,
				},
			],
			diagnostics: [],
		} as never;
		const flow = createSkillsCommandFlow({ snapshot, onRefresh: vi.fn(), onTry });
		expect(flow.items.at(-1)).toMatchObject({
			label: "review-tools:review",
			description: expect.stringContaining("Review the selected change through the Plugin"),
		});
		const push = vi.fn();
		flow.items.at(-1)!.onSelect!({ push, back: vi.fn(), close: vi.fn() });
		const detail = push.mock.calls[0]![0];
		expect(detail.title).toBe("review-tools:review");
		expect(detail.items).toContainEqual(
			expect.objectContaining({ id: "name", label: "Canonical name", description: "review-tools:review" }),
		);
		expect(detail.items).toContainEqual(
			expect.objectContaining({ id: "display-name", label: "Display name", description: "Plugin review helper" }),
		);
		expect(detail.items).toContainEqual(
			expect.objectContaining({ id: "default-prompt", description: "First line Use $review now" }),
		);
		const close = vi.fn();

		await detail.items.find(({ id }: { id: string }) => id === "try-now")!.onSelect!({
			push: vi.fn(),
			back: vi.fn(),
			close,
		});

		expect(onTry).toHaveBeenCalledWith({
			text: "First line Use $review-tools:review now ",
			commandId: "skill:a",
			name: "review-tools:review",
			start: 15,
			end: 35,
		});
		expect(close).toHaveBeenCalledOnce();
	});
});
