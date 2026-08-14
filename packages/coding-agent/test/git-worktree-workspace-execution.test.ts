import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentTool, ToolExecutionContext } from "@coda/agent";
import { Type } from "@coda/ai";
import type { OpenCodingAgentOptions, WorkGraphId, WorkItemId } from "@coda/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeProcessRunner } from "../src/host/node-process-runner.ts";
import { createGitWorktreeWorkspaceExecution } from "../src/runtime/git-worktree-workspace-execution.ts";

type WorkspaceExecution = OpenCodingAgentOptions["workspaceExecution"];
type Placement = Awaited<ReturnType<WorkspaceExecution["reserve"]>>["placement"];

const executeFile = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

function environment(): Record<string, string> {
	return Object.fromEntries(
		Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
	);
}

async function repository(): Promise<{ readonly root: string; readonly stateRoot: string }> {
	const temporary = await mkdtemp(join(tmpdir(), "coda-worktree-repo-"));
	temporaryDirectories.push(temporary);
	const root = join(temporary, "repository");
	await mkdir(root);
	await executeFile("git", ["init", "-q"], { cwd: root });
	await executeFile("git", ["config", "user.name", "Coda Test"], { cwd: root });
	await executeFile("git", ["config", "user.email", "coda-test@localhost"], { cwd: root });
	await writeFile(join(root, "shared.txt"), "base\n", "utf8");
	await executeFile("git", ["add", "shared.txt"], { cwd: root });
	await executeFile("git", ["commit", "-qm", "base"], { cwd: root });
	const stateRoot = join(temporary, "state");
	await mkdir(stateRoot, { recursive: true });
	return { root, stateRoot };
}

async function adapter(root: string, stateRoot: string): Promise<WorkspaceExecution> {
	return createGitWorktreeWorkspaceExecution({
		sourceRoot: root,
		stateRoot,
		processRunner: createNodeProcessRunner({ platform: process.platform }),
		environment: environment(),
		createTools: () => [],
	});
}

async function reserve(
	execution: WorkspaceExecution,
	itemId: string,
	order: number,
	parent?: Placement,
	graph = "graph:git",
): Promise<Placement> {
	const reservation = await execution.reserve({
		graphId: graph as WorkGraphId,
		itemId: itemId as WorkItemId,
		...(parent ? { parentItemId: "parent" as WorkItemId, parent } : {}),
		mode: "write",
		sourceOrder: order,
		publicationOrder: order,
	});
	await reservation.commit();
	return reservation.placement;
}

async function capture(execution: WorkspaceExecution, placement: Placement, itemId: string, graph = "graph:git") {
	return execution.capture({
		graphId: graph as WorkGraphId,
		itemId: itemId as WorkItemId,
		placement,
		signal: new AbortController().signal,
	});
}

async function recover(
	execution: WorkspaceExecution,
	placement: Placement,
	itemId: string,
	order: number,
	graph: string,
	expectedTargetIdentity?: string,
): Promise<Placement> {
	const reservation = await execution.recover({
		graphId: graph as WorkGraphId,
		itemId: itemId as WorkItemId,
		placement,
		mode: "write",
		sourceOrder: order,
		publicationOrder: order,
		...(expectedTargetIdentity ? { expectedTargetIdentity } : {}),
	});
	await reservation.commit();
	return reservation.placement;
}

async function publish(
	execution: WorkspaceExecution,
	placement: Placement,
	itemId: string,
	artifact: NonNullable<Awaited<ReturnType<typeof capture>>>,
	target?: Placement,
	graph = "graph:git",
) {
	return execution.publish({
		graphId: graph as WorkGraphId,
		itemId: itemId as WorkItemId,
		artifact,
		placement,
		...(target ? { target } : {}),
		signal: new AbortController().signal,
	});
}

let invocation = 0;
async function mutate(
	execution: WorkspaceExecution,
	placement: Placement,
	itemId: string,
	path: string,
	content: string,
	graph = "graph:git",
): Promise<void> {
	const mutation: AgentTool = {
		name: `write_${itemId}`,
		description: "test Workspace mutation",
		parameters: Type.Object({}, { additionalProperties: false }),
		replaySafety: "safe",
		execute: async () => {
			await writeFile(join(placement.root, path), content, "utf8");
			return { content: "written" };
		},
	};
	const [bound] = execution.bindTools({
		graphId: graph as WorkGraphId,
		itemId: itemId as WorkItemId,
		sessionId: `session:${itemId}`,
		placement,
		contributions: [{ tool: mutation, effect: "write" }],
	});
	invocation += 1;
	await bound!.execute(
		{},
		{
			signal: new AbortController().signal,
			runId: `run:${invocation}` as ToolExecutionContext["runId"],
			turnId: `turn:${invocation}` as ToolExecutionContext["turnId"],
			invocationId: `invocation:${invocation}` as ToolExecutionContext["invocationId"],
			resultMessageId: `message:${invocation}` as ToolExecutionContext["resultMessageId"],
			providerToolCallId: `provider:${invocation}`,
		},
	);
}

describe("Git worktree Workspace Execution Adapter", () => {
	it("isolates sibling writers and publishes non-conflicting artifacts in source order", async () => {
		const { root, stateRoot } = await repository();
		const execution = await adapter(root, stateRoot);
		const [alpha, beta] = await Promise.all([reserve(execution, "alpha", 0), reserve(execution, "beta", 1)]);
		await writeFile(join(alpha.root, "alpha.txt"), "alpha\n", "utf8");
		await writeFile(join(beta.root, "beta.txt"), "beta\n", "utf8");
		expect(await readFile(join(alpha.root, "alpha.txt"), "utf8")).toBe("alpha\n");
		await expect(readFile(join(alpha.root, "beta.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		const alphaArtifact = (await capture(execution, alpha, "alpha"))!;
		const betaArtifact = (await capture(execution, beta, "beta"))!;
		await expect(publish(execution, alpha, "alpha", alphaArtifact)).resolves.toMatchObject({ state: "published" });
		await expect(publish(execution, beta, "beta", betaArtifact)).resolves.toMatchObject({ state: "published" });
		expect(await readFile(join(root, "alpha.txt"), "utf8")).toBe("alpha\n");
		expect(await readFile(join(root, "beta.txt"), "utf8")).toBe("beta\n");
		await execution.release({
			graphId: "graph:git" as WorkGraphId,
			itemId: "alpha" as WorkItemId,
			placement: alpha,
			preserve: false,
		});
		await execution.release({
			graphId: "graph:git" as WorkGraphId,
			itemId: "beta" as WorkItemId,
			placement: beta,
			preserve: false,
		});
		await expect(stat(alpha.root)).rejects.toMatchObject({ code: "ENOENT" });
		await execution.close();
	});

	it("serializes different Work Graph roots by accepted Publication order instead of completion order", async () => {
		const { root, stateRoot } = await repository();
		const execution = await adapter(root, stateRoot);
		const first = await reserve(execution, "first-root", 0, undefined, "graph:first");
		const second = await reserve(execution, "second-root", 1, undefined, "graph:second");
		await writeFile(join(first.root, "first.txt"), "first\n", "utf8");
		await writeFile(join(second.root, "second.txt"), "second\n", "utf8");
		const firstArtifact = (await capture(execution, first, "first-root", "graph:first"))!;
		const secondArtifact = (await capture(execution, second, "second-root", "graph:second"))!;
		let secondSettled = false;
		const secondPublication = publish(
			execution,
			second,
			"second-root",
			secondArtifact,
			undefined,
			"graph:second",
		).then((result) => {
			secondSettled = true;
			return result;
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(secondSettled).toBe(false);

		await expect(
			publish(execution, first, "first-root", firstArtifact, undefined, "graph:first"),
		).resolves.toMatchObject({
			state: "published",
		});
		await expect(secondPublication).resolves.toMatchObject({ state: "published" });
		expect(await readFile(join(root, "first.txt"), "utf8")).toBe("first\n");
		expect(await readFile(join(root, "second.txt"), "utf8")).toBe("second\n");
		await execution.release({
			graphId: "graph:first" as WorkGraphId,
			itemId: "first-root" as WorkItemId,
			placement: first,
			preserve: false,
		});
		await execution.release({
			graphId: "graph:second" as WorkGraphId,
			itemId: "second-root" as WorkItemId,
			placement: second,
			preserve: false,
		});
		await execution.close();
	});

	it("preserves a conflicting artifact without changing the target Workspace", async () => {
		const { root, stateRoot } = await repository();
		const execution = await adapter(root, stateRoot);
		const [first, second] = await Promise.all([reserve(execution, "first", 0), reserve(execution, "second", 1)]);
		await writeFile(join(first.root, "shared.txt"), "first\n", "utf8");
		await writeFile(join(second.root, "shared.txt"), "second\n", "utf8");
		const firstArtifact = (await capture(execution, first, "first"))!;
		const secondArtifact = (await capture(execution, second, "second"))!;
		await expect(publish(execution, first, "first", firstArtifact)).resolves.toMatchObject({ state: "published" });
		await expect(publish(execution, second, "second", secondArtifact)).resolves.toMatchObject({
			state: "not_published",
			reason: "conflict",
		});
		expect(await readFile(join(root, "shared.txt"), "utf8")).toBe("first\n");
		await execution.release({
			graphId: "graph:git" as WorkGraphId,
			itemId: "second" as WorkItemId,
			placement: second,
			preserve: true,
		});
		expect((await stat(second.root)).isDirectory()).toBe(true);
		await execution.close();
	});

	it("publishes nested child work into its invoking parent before parent Publication", async () => {
		const { root, stateRoot } = await repository();
		const execution = await adapter(root, stateRoot);
		const parent = await reserve(execution, "parent", 0);
		await mutate(execution, parent, "parent", "parent.txt", "parent\n");
		const child = await reserve(execution, "child", 1, parent);
		await writeFile(join(child.root, "child.txt"), "child\n", "utf8");
		const childArtifact = (await capture(execution, child, "child"))!;
		const childPublication = await publish(execution, child, "child", childArtifact, parent);
		expect(childPublication, JSON.stringify(childPublication)).toMatchObject({
			state: "published",
			targetPlacementId: parent.placementId,
		});
		expect(await readFile(join(parent.root, "child.txt"), "utf8")).toBe("child\n");
		const parentArtifact = (await capture(execution, parent, "parent"))!;
		await expect(publish(execution, parent, "parent", parentArtifact)).resolves.toMatchObject({ state: "published" });
		expect(await readFile(join(root, "parent.txt"), "utf8")).toBe("parent\n");
		expect(await readFile(join(root, "child.txt"), "utf8")).toBe("child\n");
		await execution.close();
	});

	it("detects target changes before Publication and leaves the recoverable artifact intact", async () => {
		const { root, stateRoot } = await repository();
		const execution = await adapter(root, stateRoot);
		const worktree = await reserve(execution, "changed-source", 0);
		await writeFile(join(worktree.root, "artifact.txt"), "artifact\n", "utf8");
		const artifact = (await capture(execution, worktree, "changed-source"))!;
		await writeFile(join(root, "external.txt"), "external\n", "utf8");
		await expect(publish(execution, worktree, "changed-source", artifact)).resolves.toMatchObject({
			state: "not_published",
			reason: "changed_source",
		});
		await expect(readFile(join(root, "artifact.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readFile(join(root, "external.txt"), "utf8")).toBe("external\n");
		await execution.release({
			graphId: "graph:git" as WorkGraphId,
			itemId: "changed-source" as WorkItemId,
			placement: worktree,
			preserve: true,
		});
		expect((await stat(worktree.root)).isDirectory()).toBe(true);
		await execution.close();
	});

	it("detects content changes even when Git porcelain state stays the same", async () => {
		const { root, stateRoot } = await repository();
		await writeFile(join(root, "shared.txt"), "dirty baseline\n", "utf8");
		const execution = await adapter(root, stateRoot);
		const worktree = await reserve(execution, "same-status-change", 0);
		await writeFile(join(worktree.root, "artifact.txt"), "artifact\n", "utf8");
		const artifact = (await capture(execution, worktree, "same-status-change"))!;
		await writeFile(join(root, "shared.txt"), "externally changed\n", "utf8");

		await expect(publish(execution, worktree, "same-status-change", artifact)).resolves.toMatchObject({
			state: "not_published",
			reason: "changed_source",
		});
		await expect(readFile(join(root, "artifact.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readFile(join(root, "shared.txt"), "utf8")).toBe("externally changed\n");
		await execution.release({
			graphId: "graph:git" as WorkGraphId,
			itemId: "same-status-change" as WorkItemId,
			placement: worktree,
			preserve: true,
		});
		await execution.close();
	});

	it("does not let a later Graph reservation adopt an external target change", async () => {
		const { root, stateRoot } = await repository();
		const execution = await adapter(root, stateRoot);
		const first = await reserve(execution, "first-root", 0, undefined, "graph:first");
		await writeFile(join(first.root, "artifact.txt"), "artifact\n", "utf8");
		const artifact = (await capture(execution, first, "first-root", "graph:first"))!;
		await writeFile(join(root, "external.txt"), "external\n", "utf8");

		await expect(reserve(execution, "second-root", 1, undefined, "graph:second")).rejects.toThrow(
			"Target Workspace changed outside the Adapter before Placement reservation",
		);
		await expect(publish(execution, first, "first-root", artifact, undefined, "graph:first")).resolves.toMatchObject({
			state: "not_published",
			reason: "changed_source",
		});
		await expect(readFile(join(root, "artifact.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readFile(join(root, "external.txt"), "utf8")).toBe("external\n");
		await execution.release({
			graphId: "graph:first" as WorkGraphId,
			itemId: "first-root" as WorkItemId,
			placement: first,
			preserve: true,
		});
		await execution.close();
	});

	it("rejects recovery when the Publication target changed after the durable reservation", async () => {
		const { root, stateRoot } = await repository();
		const live = await adapter(root, stateRoot);
		const placement = await reserve(live, "recover-root", 0, undefined, "graph:recover");
		await writeFile(join(placement.root, "artifact.txt"), "artifact\n", "utf8");
		const artifact = (await capture(live, placement, "recover-root", "graph:recover"))!;
		await live.close();
		await writeFile(join(root, "external.txt"), "external\n", "utf8");

		const recovered = await adapter(root, stateRoot);
		await expect(recover(recovered, placement, "recover-root", 0, "graph:recover")).rejects.toThrow(
			"Recovered Publication target changed outside the Adapter",
		);
		await expect(readFile(join(root, "artifact.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readFile(join(root, "external.txt"), "utf8")).toBe("external\n");
		expect(artifact.reference).toBeTruthy();
		expect((await stat(placement.root)).isDirectory()).toBe(true);
		await recovered.close();
	});

	it("recovers against the latest durably published target identity", async () => {
		const { root, stateRoot } = await repository();
		const live = await adapter(root, stateRoot);
		const first = await reserve(live, "first-root", 0, undefined, "graph:first");
		const second = await reserve(live, "second-root", 1, undefined, "graph:second");
		await writeFile(join(first.root, "first.txt"), "first\n", "utf8");
		await writeFile(join(second.root, "second.txt"), "second\n", "utf8");
		const firstArtifact = (await capture(live, first, "first-root", "graph:first"))!;
		const secondArtifact = (await capture(live, second, "second-root", "graph:second"))!;
		const firstPublication = await publish(live, first, "first-root", firstArtifact, undefined, "graph:first");
		expect(firstPublication).toMatchObject({ state: "published", targetIdentity: expect.any(String) });
		if (firstPublication.state === "not_published" || !firstPublication.targetIdentity) {
			throw new Error("First Publication did not persist a target identity");
		}
		await live.close();

		const recovered = await adapter(root, stateRoot);
		const recoveredSecond = await recover(
			recovered,
			second,
			"second-root",
			1,
			"graph:second",
			firstPublication.targetIdentity,
		);
		await expect(
			publish(recovered, recoveredSecond, "second-root", secondArtifact, undefined, "graph:second"),
		).resolves.toMatchObject({ state: "published" });
		expect(await readFile(join(root, "first.txt"), "utf8")).toBe("first\n");
		expect(await readFile(join(root, "second.txt"), "utf8")).toBe("second\n");
		await recovered.close();
	});
});
