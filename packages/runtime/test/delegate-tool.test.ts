import type { ToolExecutionContext } from "@coda/agent";
import { describe, expect, it, vi } from "vitest";
import { createDelegateTool } from "../src/work-graph/delegate-tool.ts";
import type { WorkItemId, WorkResult } from "../src/work-graph/types.ts";

function context(): ToolExecutionContext {
	return {
		signal: new AbortController().signal,
		runId: "run:delegate" as ToolExecutionContext["runId"],
		turnId: "turn:delegate" as ToolExecutionContext["turnId"],
		invocationId: "invocation:delegate" as ToolExecutionContext["invocationId"],
		resultMessageId: "message:delegate" as ToolExecutionContext["resultMessageId"],
		providerToolCallId: "provider:delegate",
	};
}

function result(): WorkResult {
	return {
		itemId: "child" as WorkItemId,
		parentItemId: "root" as WorkItemId,
		dependencies: [],
		runtimeId: "worker:private",
		sessionId: "session:private",
		state: "succeeded",
		run: { runId: "run:child", outcome: "success", assistantText: "x".repeat(10_000) },
		evidence: { version: 1, facts: { private: "evidence" } },
		placement: { placementId: "placement:private", root: "/private", baseIdentity: "base", kind: "memory" },
		publication: { state: "published", publicationId: "publication:child" },
		diagnostics: Array.from({ length: 20 }, (_, index) => ({
			code: `diagnostic:${index}`,
			message: "y".repeat(2_000),
		})),
		timing: { acceptedAt: 1, settledAt: 2 },
		budget: { modelAttempts: 1, toolInvocations: 0, totalTokens: 10, elapsedMs: 1 },
	};
}

describe("bound delegate Tool", () => {
	it("exposes only bounded child specifications and returns a bounded structured Work Result projection", async () => {
		const execute = vi.fn(async () => [result()]);
		const tool = createDelegateTool({ execute });
		const schema = JSON.stringify(tool.parameters);
		expect(schema).toContain('"maxItems":8');
		expect(schema).not.toMatch(/graphId|runtimeId|sessionId|parentItemId/u);

		const output = await tool.execute(
			{
				items: [{ itemId: "child", objective: "bounded child", executionMode: "write" }],
			},
			context(),
		);
		expect(execute).toHaveBeenCalledWith(
			[{ itemId: "child", objective: "bounded child", executionMode: "write" }],
			expect.any(Object),
		);
		const modelProjection = JSON.parse(String(output.content));
		expect(modelProjection.results[0]).toMatchObject({
			itemId: "child",
			parentItemId: "root",
			state: "succeeded",
			run: { outcome: "success" },
			publication: { state: "published" },
		});
		expect(modelProjection.results[0].run.assistantText.length).toBeLessThanOrEqual(4_097);
		expect(modelProjection.results[0].diagnostics).toHaveLength(8);
		expect(JSON.stringify(modelProjection)).not.toMatch(/worker:private|session:private|placement:private|evidence/u);
		expect(output.observation).toMatchObject({ status: "ok", truncated: true, facts: { itemCount: 1 } });
	});
});
