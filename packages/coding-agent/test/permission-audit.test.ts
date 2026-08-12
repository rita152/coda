import { compileSandboxPolicy, createReadAccessPolicy } from "@coda/sandbox";
import { describe, expect, it } from "vitest";
import { approvalDecisionAuditEvent, type PermissionAuditEvent } from "../src/permissions/audit.ts";
import {
	createAuditedModelProcessRunner,
	createAuditedModelProcessSessionRunner,
	type ModelProcessRunner,
	type ModelProcessSessionRunner,
} from "../src/permissions/model-process-runner.ts";
import { isSessionRecordPayload } from "../src/session/v1-schema.ts";

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
	it("accepts content-free native read decisions in the Session schema", () => {
		const event: PermissionAuditEvent = {
			type: "read_access",
			invocationId: "invocation:read",
			toolName: "read",
			requestedPath: "../credentials.json",
			canonicalPath: "/home/user/.config/gcloud/credentials.json",
			recursive: false,
			outcome: "denied",
			reason: "denied-read-root",
		};

		expect(isSessionRecordPayload("permission_audit_recorded", { event }, 5)).toBe(true);
		expect(
			isSessionRecordPayload(
				"permission_audit_recorded",
				{ event: { ...event, contents: "must not be persisted" } },
				5,
			),
		).toBe(false);
	});

	it("stores denial metadata and a bounded sanitized summary instead of full feedback", () => {
		const feedback = `Run npm pack first\n\u001b[31m${"inspect ".repeat(40)}`;
		const event = approvalDecisionAuditEvent(
			{
				kind: "command",
				runId: "run:1" as never,
				turnId: "turn:1" as never,
				invocationId: "invocation:1" as never,
				cwd: "/workspace",
				reason: "command requires approval",
			},
			{ type: "denied", rejection: feedback },
		);

		expect(event).toEqual({
			type: "approval_decision",
			invocationId: "invocation:1",
			kind: "command",
			outcome: "denied",
			denial: {
				type: "feedback",
				characterCount: Array.from(feedback).length,
				summary: expect.any(String),
			},
		});
		if (event.type !== "approval_decision" || !event.denial) throw new Error("expected denial projection");
		expect(event.denial.summary.length).toBeLessThanOrEqual(160);
		expect(event.denial.summary).not.toContain("\u001b");
		expect(JSON.stringify(event)).not.toContain(feedback);

		const unicode = approvalDecisionAuditEvent(
			{
				kind: "command",
				runId: "run:2" as never,
				turnId: "turn:2" as never,
				invocationId: "invocation:2" as never,
				cwd: "/workspace",
				reason: "command requires approval",
			},
			{ type: "denied", rejection: "🙂".repeat(200) },
		);
		expect(Array.from(unicode.denial?.summary ?? "")).toHaveLength(160);
		expect(isSessionRecordPayload("permission_audit_recorded", { event: unicode }, 5)).toBe(true);
	});

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
			readAccessPolicy: createReadAccessPolicy(policy),
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
				readAccessPolicy: createReadAccessPolicy(policy),
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

	it("audits a background process through completion using its start invocation", async () => {
		const events: PermissionAuditEvent[] = [];
		const defaultEvents: PermissionAuditEvent[] = [];
		const delegate: ModelProcessSessionRunner = {
			start: async () => {
				const completion = Promise.resolve({
					exitCode: 0,
					signal: null,
					stdout: "done",
					stderr: "",
					timedOut: false,
					truncated: false,
					backend: "macos-seatbelt" as const,
				});
				return {
					backend: "macos-seatbelt",
					completion,
					write: async () => undefined,
					closeStdin: async () => undefined,
					stop: () => completion,
				};
			},
		};
		const audited = createAuditedModelProcessSessionRunner(delegate, (event) => {
			defaultEvents.push(event);
		});

		const processSession = await audited.start(request, {
			readAccessPolicy: createReadAccessPolicy(policy),
			auditContext: { invocationId: "invocation:process", toolName: "process_start" },
			audit: (event) => {
				events.push(event);
			},
		});
		await processSession.completion;

		expect(defaultEvents).toEqual([]);
		expect(events).toEqual([
			expect.objectContaining({
				type: "sandbox_execution",
				invocationId: "invocation:process",
				toolName: "process_start",
				backend: "macos-seatbelt",
				outcome: "success",
			}),
		]);
	});
});
