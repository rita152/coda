import { access, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@coda/ai";
import { afterEach, describe, expect, it } from "vitest";
import { type ApplicationOutput, createCodingAgentApplication } from "../src/application.ts";
import { createNodeFileSystem } from "../src/host/node-file-system.ts";
import { createNodeProcessRunner } from "../src/host/node-process-runner.ts";
import { testTimeRuntime } from "./time-runtime.ts";

class BufferOutput implements ApplicationOutput {
	readonly isTTY = false;
	value = "";

	write(chunk: string): void {
		this.value += chunk;
	}
}

const supported = process.platform === "darwin" || process.platform === "linux";
const integration = supported ? describe : describe.skip;
const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

integration("model Bash escalation", () => {
	it("grants one reviewed unsandboxed command, retains Workspace, and never retries a later denial", async () => {
		// Linux Workspace mode intentionally permits /tmp. Keep the fixture under
		// the package so its sibling really is outside every writable root.
		const fixture = await mkdtemp(join(process.cwd(), ".coda-bash-escalation-"));
		temporaryDirectories.push(fixture);
		const workspace = join(fixture, "workspace");
		const outside = join(fixture, "outside");
		await Promise.all([mkdir(workspace), mkdir(outside)]);
		const canonicalOutside = await realpath(outside);
		const escalatedTarget = join(canonicalOutside, "escalated.txt");
		const deniedTarget = join(canonicalOutside, "denied.txt");
		const faux = fauxProvider({ runtime: testTimeRuntime(920) });
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall(
					"bash",
					{
						command: `printf escalated > ${JSON.stringify(escalatedTarget)}`,
						sandbox_permissions: "require_escalated",
						justification: "Write the explicitly reviewed outside artifact",
					},
					{ id: "provider-escalated" },
				),
				{ stopReason: "toolUse", timestamp: 920 },
			),
			(context) => {
				expect(context.messages.at(-1)).toMatchObject({
					role: "toolResult",
					toolCallId: "provider-escalated",
					isError: false,
					details: { backend: "none", exitCode: 0 },
				});
				return fauxAssistantMessage(
					fauxToolCall(
						"bash",
						{ command: `printf escaped > ${JSON.stringify(deniedTarget)}` },
						{ id: "provider-default-denied" },
					),
					{ stopReason: "toolUse", timestamp: 920 },
				);
			},
			(context) => {
				expect(context.messages.at(-1)).toMatchObject({
					role: "toolResult",
					toolCallId: "provider-default-denied",
					isError: true,
					details: {
						backend: process.platform === "darwin" ? "macos-seatbelt" : "linux-bwrap",
						denial: expect.objectContaining({ kind: "filesystem" }),
					},
				});
				return fauxAssistantMessage("The precise elevation did not change the active Workspace profile.", {
					timestamp: 920,
				});
			},
		]);
		const models = createModels({ runtime: testTimeRuntime(920) });
		models.setProvider(faux.provider);
		const stdout = new BufferOutput();
		const stderr = new BufferOutput();
		let approvals = 0;
		let id = 0;
		const application = createCodingAgentApplication({
			models,
			settings: {
				load: async () => ({ permissions: { profile: "workspace", approvalPolicy: "on-request" } }),
				save: async () => undefined,
			},
			approval: {
				decide: async () => {
					approvals++;
					return { type: "approved" };
				},
			},
			fileSystem: createNodeFileSystem(),
			processRunner: createNodeProcessRunner({ platform: process.platform }),
			io: { stdin: { isTTY: false, readAll: async () => "" }, stdout, stderr },
			runtime: {
				cwd: workspace,
				homeDirectory: fixture,
				platform: process.platform,
				environment: { HOME: fixture, PATH: process.env.PATH, SHELL: "/bin/sh" },
				clock: { now: () => 920 },
				idGenerator: { generate: (kind) => `${kind}:${++id}` },
			},
		});

		const exitCode = await application.run([
			"--print",
			"--model",
			`${faux.getModel().provider}/${faux.getModel().id}`,
			"perform one reviewed outside write",
		]);

		expect(exitCode, stderr.value).toBe(0);
		expect(approvals).toBe(1);
		expect(await readFile(escalatedTarget, "utf8")).toBe("escalated");
		await expect(access(deniedTarget)).rejects.toMatchObject({ code: "ENOENT" });
	});
});
