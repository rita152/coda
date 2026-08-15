import type { AgentTool, ToolExecutionContext, ToolExecutionOutput } from "@coda/agent";
import { Type } from "@coda/ai";
import type { WorkGraphId, WorkItemId, WorkspaceExecution } from "@coda/runtime";
import { describe, expect, it, vi } from "vitest";
import { createDirectWorkspaceExecution } from "../src/runtime/direct-workspace-execution.ts";

type WorkspaceToolContribution = Awaited<ReturnType<WorkspaceExecution["tooling"]["tools"]>>[number];

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

function tool(name: string, execute: () => Promise<ToolExecutionOutput>): AgentTool {
	return {
		name,
		description: name,
		parameters: Type.Object({}, { additionalProperties: false }),
		replaySafety: "safe",
		execute,
	};
}

let invocation = 0;
function context(): ToolExecutionContext {
	invocation++;
	return {
		signal: new AbortController().signal,
		runId: `run:${invocation}` as ToolExecutionContext["runId"],
		turnId: `turn:${invocation}` as ToolExecutionContext["turnId"],
		invocationId: `invocation:${invocation}` as ToolExecutionContext["invocationId"],
		resultMessageId: `message:${invocation}` as ToolExecutionContext["resultMessageId"],
		providerToolCallId: `provider:${invocation}`,
	};
}

async function placement(execution: WorkspaceExecution, itemId: string) {
	return (
		await execution.placement.reserve({
			graphId: "graph:direct" as WorkGraphId,
			itemId: itemId as WorkItemId,
			mode: "write",
			sourceOrder: 0,
			publicationOrder: 0,
		})
	).placement;
}

function bind(
	execution: WorkspaceExecution,
	workspacePlacement: Awaited<ReturnType<WorkspaceExecution["placement"]["reserve"]>>["placement"],
	itemId: string,
	contributions: readonly WorkspaceToolContribution[],
): readonly AgentTool[] {
	return execution.tooling.bindTools({
		graphId: "graph:direct" as WorkGraphId,
		itemId: itemId as WorkItemId,
		sessionId: `session:${itemId}`,
		placement: workspacePlacement,
		contributions,
	});
}

describe("Direct Workspace Execution Adapter", () => {
	it("overlaps FIFO reads and serializes Workspace write and unknown effects across workers", async () => {
		const firstRead = deferred();
		const secondRead = deferred();
		const write = deferred();
		const lateRead = deferred();
		const log: string[] = [];
		const execution = createDirectWorkspaceExecution({ root: "/workspace", createTools: () => [] });
		const firstPlacement = await placement(execution, "first");
		const secondPlacement = await placement(execution, "second");
		const [readOne, readTwo] = bind(execution, firstPlacement, "first", [
			{
				tool: tool("read_one", async () => {
					log.push("read_one:start");
					await firstRead.promise;
					log.push("read_one:end");
					return { content: "one" };
				}),
				effect: "read",
			},
			{
				tool: tool("read_two", async () => {
					log.push("read_two:start");
					await secondRead.promise;
					log.push("read_two:end");
					return { content: "two" };
				}),
				effect: "read",
			},
		]);
		const [writeTool, lateReadTool] = bind(execution, secondPlacement, "second", [
			{
				tool: tool("write", async () => {
					log.push("write:start");
					await write.promise;
					log.push("write:end");
					return { content: "write" };
				}),
				effect: "write",
			},
			{
				tool: tool("late_read", async () => {
					log.push("late_read:start");
					await lateRead.promise;
					log.push("late_read:end");
					return { content: "late" };
				}),
				effect: "read",
			},
		]);
		const operations = [
			readOne!.execute({}, context()),
			readTwo!.execute({}, context()),
			writeTool!.execute({}, context()),
			lateReadTool!.execute({}, context()),
		];
		await vi.waitFor(() => expect(log).toEqual(["read_one:start", "read_two:start"]));
		firstRead.resolve();
		secondRead.resolve();
		await vi.waitFor(() => expect(log).toContain("write:start"));
		expect(log).not.toContain("late_read:start");
		write.resolve();
		await vi.waitFor(() => expect(log).toContain("late_read:start"));
		lateRead.resolve();
		await Promise.all(operations);
		expect(log).toEqual([
			"read_one:start",
			"read_two:start",
			"read_one:end",
			"read_two:end",
			"write:start",
			"write:end",
			"late_read:start",
			"late_read:end",
		]);
		await execution.placement.close();
	});

	it("retains an unknown Process lease until the background lifetime settles", async () => {
		const processLifetime = deferred();
		const readGate = deferred();
		const log: string[] = [];
		const execution = createDirectWorkspaceExecution({ root: "/workspace", createTools: () => [] });
		const workspacePlacement = await placement(execution, "process");
		const [start, control, read] = bind(execution, workspacePlacement, "process", [
			{
				tool: tool("process_start", async () => {
					log.push("process:start");
					return { content: "started", details: { processId: "process:one", state: "running" } };
				}),
				effect: "unknown",
				retainLease: () => ({ identity: "process:one", settled: processLifetime.promise }),
			},
			{
				tool: tool("process_control", async () => {
					log.push("process:control");
					return { content: "controlled" };
				}),
				effect: "unknown",
				leaseIdentity: (arguments_) =>
					typeof arguments_ === "object" && arguments_ !== null && "processId" in arguments_
						? String(arguments_.processId)
						: undefined,
			},
			{
				tool: tool("read", async () => {
					log.push("read:start");
					await readGate.promise;
					return { content: "read" };
				}),
				effect: "read",
			},
		]);
		await start!.execute({}, context());
		await control!.execute({ processId: "process:one" }, context());
		const reading = read!.execute({}, context());
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(log).toEqual(["process:start", "process:control"]);
		processLifetime.resolve();
		await vi.waitFor(() => expect(log).toEqual(["process:start", "process:control", "read:start"]));
		readGate.resolve();
		await reading;
		await execution.placement.close();
	});
});
