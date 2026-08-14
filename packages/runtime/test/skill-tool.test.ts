import type { ToolExecutionContext } from "@coda/agent";
import type { SkillId, SkillRevision } from "@coda/skills";
import { describe, expect, it } from "vitest";
import { createSkillTool, modelVisibleSkillIds } from "../src/skills/tool.ts";
import type { CodingSkillsSnapshot } from "../src/skills/types.ts";

function snapshot(): CodingSkillsSnapshot {
	const id = `skill:${"a".repeat(32)}` as SkillId;
	const candidate = {
		id,
		revision: "b".repeat(64) as SkillRevision,
		metadata: { name: "visible", description: "Visible workflow" },
		skillFile: "/skills/visible/SKILL.md",
	};
	const resolved = {
		candidate,
		origin: { scope: "workspace" as const, root: "/skills", priority: 0 },
		precedence: 0,
		winner: true,
		collisionCount: 1,
		sourceLabel: "./.agents/skills",
		qualifiedName: "visible",
	};
	return {
		loader: {} as never,
		candidates: [candidate] as never,
		resolved: [resolved] as never,
		byId: new Map([[id, resolved]]) as never,
		diagnostics: [],
		activate: async (_id, options) =>
			({
				candidate,
				revision: candidate.revision,
				baseDirectory: "/skills/visible",
				body: "Visible body",
				arguments: options?.arguments,
				resources: [],
				diagnostics: [],
			}) as never,
	};
}

describe("Skill Tool Run snapshot", () => {
	it("exposes frozen Skill identities and exact activation provenance", async () => {
		const skills = snapshot();
		expect(modelVisibleSkillIds(skills)).toEqual([skills.resolved[0]!.candidate.id]);
		const tool = createSkillTool(skills)!;
		const execution = {
			signal: new AbortController().signal,
			runId: "run:1",
			turnId: "turn:1",
			invocationId: "invocation:1",
			resultMessageId: "message:1",
			providerToolCallId: "provider:1",
		} as unknown as ToolExecutionContext;
		const result = await tool.execute(
			{ skill: String(skills.resolved[0]!.candidate.id), arguments: "focus" },
			execution,
		);

		expect(result.content).toContain("Visible body");
		expect(result.observation).toMatchObject({
			status: "ok",
			truncated: false,
			facts: { resourceCount: 0, diagnosticCount: 0 },
		});
		expect(result.details).toMatchObject({ name: "visible", arguments: "focus" });
	});
});
