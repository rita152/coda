import type { ToolPolicyRequest } from "@coda/agent";
import { describe, expect, it, vi } from "vitest";
import type { PermissionEngine } from "../src/permissions/permission-engine.ts";
import { RunPermissionRouter } from "../src/runtime/run-permission-router.ts";
import { RunRuntimeSlot } from "../src/runtime/run-runtime-slot.ts";

describe("RunPermissionRouter", () => {
	it("keeps policy checks on the active Run's engine until the next Run begins", async () => {
		const workspace = permissionEngine("workspace");
		const readonly = permissionEngine("read-only");
		const slot = new RunRuntimeSlot({ permission: workspace });
		const router = new RunPermissionRouter(slot, ({ permission }) => permission);

		const first = slot.begin();
		slot.select({ permission: readonly });
		await router.check(request("invocation:first"));

		expect(workspace.check).toHaveBeenCalledOnce();
		expect(readonly.check).not.toHaveBeenCalled();

		slot.end(first.id);
		slot.begin();
		await router.check(request("invocation:next"));

		expect(readonly.check).toHaveBeenCalledOnce();
	});
});

function permissionEngine(profile: string): PermissionEngine {
	return {
		check: vi.fn(async () => ({ decision: "allow" as const })),
		configuration: vi.fn(() => ({ profile: { profile }, approvalPolicy: "on-request" })),
	} as unknown as PermissionEngine;
}

function request(invocationId: string): ToolPolicyRequest {
	return {
		runId: "run:one" as ToolPolicyRequest["runId"],
		turnId: "turn:one" as ToolPolicyRequest["turnId"],
		invocationId: invocationId as ToolPolicyRequest["invocationId"],
		resultMessageId: "message:one" as ToolPolicyRequest["resultMessageId"],
		providerToolCallId: "call:one",
		toolName: "read",
		arguments: {},
		replaySafety: "safe",
	};
}
