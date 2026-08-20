import { describe, expect, it } from "vitest";
import { eventRecordInputs } from "../../src/session/records.ts";

describe("MCP Session redaction", () => {
	it("persists argument shape and bounded projection metadata without MCP values or opaque state", () => {
		const invocation = {
			id: "invocation:1",
			resultMessageId: "message:result",
			providerToolCallId: "provider-call",
			toolName: "mcp__deploy__release",
			arguments: { token: "secret", region: "eu", nested: { requestState: "opaque" } },
			sourceIndex: 0,
			replaySafety: "never",
		};
		const started = eventRecordInputs({ type: "tool_execution_start", invocation } as never, undefined);

		expect(started).toEqual([
			{
				type: "tool_started",
				payload: {
					invocation: {
						...invocation,
						arguments: {
							_codaMcpRedacted: true,
							keys: ["nested", "region", "token"],
							keyCount: 3,
						},
					},
				},
			},
		]);
		expect(JSON.stringify(started)).not.toContain("secret");
		expect(JSON.stringify(started)).not.toContain("opaque");

		const finished = eventRecordInputs(
			{
				type: "tool_execution_end",
				invocation,
				outcome: "success",
				result: {
					id: "message:result",
					message: {
						role: "toolResult",
						toolCallId: "provider-call",
						toolName: invocation.toolName,
						content: [{ type: "text", text: "done" }],
						timestamp: 1,
						details: {
							kind: "mcp",
							catalogRevision: 4,
							serverId: "deploy",
							serverSemanticName: "portable-tools:deploy",
							remoteToolName: "release",
							contentTypes: ["text"],
							hasStructuredContent: false,
							truncated: false,
							requestState: "opaque",
							elicitationValues: { confirm: true },
						},
					},
				},
			} as never,
			undefined,
		);

		const serialized = JSON.stringify(finished);
		expect(serialized).not.toContain("opaque");
		expect(serialized).not.toContain("elicitationValues");
		expect(finished[1]).toMatchObject({
			type: "message_committed",
			payload: {
				message: {
					message: {
						details: {
							kind: "mcp",
							catalogRevision: 4,
							serverId: "deploy",
							serverSemanticName: "portable-tools:deploy",
							remoteToolName: "release",
							contentTypes: ["text"],
							hasStructuredContent: false,
							truncated: false,
						},
					},
				},
			},
		});
	});
});
