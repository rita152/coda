import { describe, expect, it, vi } from "vitest";
import type { SkillMcpDependencyDecisionRequest } from "../src/skills/mcp-dependency-coordinator.ts";
import { InteractiveSkillMcpDependencyHandler } from "../src/ui/skill-mcp-dependency.ts";

function request(): SkillMcpDependencyDecisionRequest {
	return {
		title: "Install MCP servers?",
		message: "Install docs?",
		choices: [
			{ id: "install", label: "Install", description: "Install docs." },
			{ id: "continue", label: "Continue anyway", description: "Continue without docs." },
		],
		missing: [],
		signal: new AbortController().signal,
	};
}

describe("InteractiveSkillMcpDependencyHandler", () => {
	it("never starts its fallback prompt while the host says a full-screen lease is active", async () => {
		const fallback = vi.fn(async () => "install" as const);
		const handler = new InteractiveSkillMcpDependencyHandler({ fallback, canUseFallback: () => false });

		await expect(handler.forSession("session:one")(request())).resolves.toBe("continue");
		expect(fallback).not.toHaveBeenCalled();
	});

	it("uses its terminal fallback only when no host full-screen lease is active", async () => {
		const fallback = vi.fn(async () => "install" as const);
		const handler = new InteractiveSkillMcpDependencyHandler({ fallback, canUseFallback: () => true });

		await expect(handler.forSession("session:one")(request())).resolves.toBe("install");
		expect(fallback).toHaveBeenCalledOnce();
	});
});
