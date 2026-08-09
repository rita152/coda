import { compileSandboxPolicy } from "@coda/sandbox";
import { describe, expect, it } from "vitest";
import type { PermissionAuditEvent } from "../src/permissions/audit.ts";
import { createAuditedModelProcessRunner, type ModelProcessRunner } from "../src/permissions/model-process-runner.ts";

const policy = compileSandboxPolicy({
	profile: "workspace",
	workspaceRoots: ["/workspace"],
	temporaryDirectory: "/tmp",
});

const request = {
	executable: "/bin/true",
	args: [] as const,
	cwd: "/workspace",
	environment: {},
	signal: new AbortController().signal,
	timeoutMs: 1_000,
	maxOutputBytes: 1_024,
	maxOutputLines: 100,
};

describe("Permission audit", () => {
	it("records the effective backend, roots, and normal process outcome", async () => {
		const events: PermissionAuditEvent[] = [];
		const delegate: ModelProcessRunner = {
			run: async () => ({
				exitCode: 0,
				signal: null,
				stdout: "",
				stderr: "",
				timedOut: false,
				truncated: false,
				backend: "macos-seatbelt",
			}),
		};
		const audited = createAuditedModelProcessRunner(delegate, (event) => {
			events.push(event);
		});

		await audited.run(request, {
			policy,
			auditContext: { invocationId: "invocation:1", toolName: "bash" },
		});

		expect(events).toEqual([
			expect.objectContaining({
				type: "sandbox_execution",
				invocationId: "invocation:1",
				toolName: "bash",
				backend: "macos-seatbelt",
				outcome: "success",
				policy: expect.objectContaining({
					profile: "workspace",
					protectedMetadataRoots: policy.protectedMetadataRoots,
				}),
			}),
		]);
	});

	it("records fail-closed launch failures before propagating them", async () => {
		const events: PermissionAuditEvent[] = [];
		const delegate: ModelProcessRunner = {
			run: async () => {
				throw new Error("Sandbox backend unavailable");
			},
		};
		const audited = createAuditedModelProcessRunner(delegate, (event) => {
			events.push(event);
		});

		await expect(
			audited.run(request, {
				policy,
				auditContext: { invocationId: "invocation:2", toolName: "find" },
			}),
		).rejects.toThrow("Sandbox backend unavailable");
		expect(events).toEqual([
			expect.objectContaining({
				type: "sandbox_execution",
				invocationId: "invocation:2",
				toolName: "find",
				outcome: "launch-failed",
				error: "Sandbox backend unavailable",
			}),
		]);
	});
});
