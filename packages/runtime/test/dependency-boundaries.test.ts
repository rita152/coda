import { access, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

async function sourceFiles(root: string): Promise<readonly string[]> {
	const files: string[] = [];
	for (const entry of await readdir(root, { withFileTypes: true })) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
		else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
	}
	return files;
}

describe("Work Graph dependency boundaries", () => {
	it("keeps every headless Runtime implementation independent from CLI and TUI Modules", async () => {
		const root = new URL("../src", import.meta.url).pathname;
		for (const file of await sourceFiles(root)) {
			const source = await readFile(file, "utf8");
			expect(source, file).not.toMatch(
				/@coda\/(?:tui|coding-agent|mcp|skills)|packages\/coding-agent|coding-agent\/src/u,
			);
		}
		const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
			dependencies?: Record<string, string>;
		};
		expect(Object.keys(manifest.dependencies ?? {})).not.toContain("@coda/tui");
		expect(Object.keys(manifest.dependencies ?? {})).not.toContain("@coda/coding-agent");
		expect(Object.keys(manifest.dependencies ?? {})).not.toContain("@coda/mcp");
		expect(Object.keys(manifest.dependencies ?? {})).not.toContain("@coda/skills");
	});

	it("keeps application composition above the one public Work Graph factory", async () => {
		const application = await readFile(new URL("../../coding-agent/src/application.ts", import.meta.url), "utf8");
		const coordinator = await readFile(
			new URL("../../coding-agent/src/runtime/workspace-work-coordinator.ts", import.meta.url),
			"utf8",
		);
		expect(application).not.toMatch(
			/new Agent\b|openCodingAgent\(|openPrivateWorkerRuntime|ContextWindowController|ContextOverflowRecovery|PreparedRun/u,
		);
		expect(application).toMatch(/createWorkspaceWorkCoordinator/u);
		expect(coordinator.match(/openCodingAgent\(\{/gu)).toHaveLength(1);
		expect(coordinator).toMatch(/\.observe\(\{ capacity:/u);
		expect(coordinator).toMatch(/new SessionWorkController/u);
	});

	it("keeps Worker Runtime construction and executable lifecycle private", async () => {
		const coordinator = await readFile(new URL("../src/work-graph/worker-lifecycle.ts", import.meta.url), "utf8");
		const worker = await readFile(new URL("../src/work-graph/worker-runtime.ts", import.meta.url), "utf8");
		const ports = await readFile(new URL("../src/work-graph/ports.ts", import.meta.url), "utf8");
		const publicIndex = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
		expect(coordinator.match(/openPrivateWorkerRuntime\(\{/gu)).toHaveLength(1);
		expect(worker).toMatch(/new Agent\(/u);
		expect(worker).toMatch(/new ContextWindowController/u);
		expect(publicIndex).not.toMatch(/worker-runtime|PreparedRun|ContextWindowController|RuntimeInput/u);
		expect(ports).not.toMatch(/WorkerPromptPreparer|preparePrompt/u);
		expect(ports).not.toMatch(/observeWorkerEvent/u);
		expect(ports).toMatch(/readonly modelProvider: RunModelProvider/u);
		expect(ports).toMatch(/readonly capabilitySources: readonly RunCapabilitySource\[\]/u);
		expect(ports).not.toMatch(/readonly runCapabilities:/u);
		expect(publicIndex).toMatch(/createRunCapabilityHost/u);

		for (const obsolete of ["coding-agent-runtime.ts", "runtime.ts", "input-queue.ts", "types.ts"]) {
			await expect(access(new URL(`../src/${obsolete}`, import.meta.url))).rejects.toThrow();
		}
	});

	it("keeps Worker Facts, Observations, and Control on separate closed paths", async () => {
		const runtimeRoot = new URL("../src/work-graph", import.meta.url).pathname;
		const codingRuntimeRoot = new URL("../../coding-agent/src/runtime", import.meta.url).pathname;
		const production = (
			await Promise.all(
				[...(await sourceFiles(runtimeRoot)), ...(await sourceFiles(codingRuntimeRoot))].map((file) =>
					readFile(file, "utf8"),
				),
			)
		).join("\n");
		for (const obsolete of [
			["worker", "event"].join("_"),
			["fatal", "barrier", "failed"].join("_"),
			["Worker", "Runtime", "Event"].join(""),
			["control", "Worker", "Event"].join(""),
			["observation", "Tail"].join(""),
			["progress", "Queue"].join(""),
		]) {
			expect(production, obsolete).not.toContain(obsolete);
		}

		const worker = await readFile(new URL("../src/work-graph/worker-runtime.ts", import.meta.url), "utf8");
		const ports = await readFile(new URL("../src/work-graph/ports.ts", import.meta.url), "utf8");
		const facts = await readFile(new URL("../src/work-graph/work-graph-fact.ts", import.meta.url), "utf8");
		const sessionController = await readFile(
			new URL("../../coding-agent/src/runtime/session-work-controller.ts", import.meta.url),
			"utf8",
		);
		expect(worker).toMatch(/routeWorkerEvent\(event\)/u);
		expect(worker).toMatch(/readonly commitFact: \(fact: WorkerFact,/u);
		expect(worker).toMatch(/readonly publishObservation: \(observation: WorkerObservation,/u);
		expect(facts).toMatch(/readonly type: "worker_fact_recorded"/u);
		expect(ports).not.toMatch(/AgentEvent/u);
		expect(sessionController).toMatch(/capacity \?\? 256/u);
		expect(sessionController).toMatch(/type: "resync_required"/u);
	});

	it("routes interactive input and evaluation through the public Work Graph Seam", async () => {
		const interactive = await readFile(
			new URL("../../coding-agent/src/ui/input-controller.ts", import.meta.url),
			"utf8",
		);
		const evaluation = await readFile(new URL("../../evals/src/runtime-adapter.ts", import.meta.url), "utf8");
		const suite = await readFile(new URL("../../evals/src/suite.ts", import.meta.url), "utf8");
		expect(interactive).toMatch(/SessionWorkController/u);
		expect(interactive).not.toMatch(/RuntimeInputQueue|RuntimeInputLifecycle|@coda\/runtime/u);
		expect(evaluation).toMatch(/createHeadlessCodingAgent/u);
		expect(evaluation).not.toMatch(/openAgentRuntime|openCodingAgentRuntime/u);
		expect(suite).not.toMatch(/new Agent\b|openAgentRuntime|openCodingAgentRuntime/u);
	});

	it("keeps foreground focus as a Session-pane concern rather than a scheduler map", async () => {
		const panes = await readFile(
			new URL("../../coding-agent/src/ui/workspace-session-panes.ts", import.meta.url),
			"utf8",
		);
		expect(panes).toMatch(/class WorkspaceSessionPanes/u);
		expect(panes).not.toMatch(/Runtime|@coda\/runtime|WorkGraph/u);
		await expect(
			access(new URL("../../coding-agent/src/runtime/workspace-session-runtimes.ts", import.meta.url)),
		).rejects.toThrow();
	});

	it("constructs one Workspace-owned mutation coordinator rather than one per Worker", async () => {
		const coordinator = await readFile(
			new URL("../../coding-agent/src/runtime/workspace-work-coordinator.ts", import.meta.url),
			"utf8",
		);
		const toolFactory = await readFile(new URL("../../coding-agent/src/tools/index.ts", import.meta.url), "utf8");
		expect(coordinator.match(/new TargetMutationCoordinator\(\)/gu)).toHaveLength(1);
		expect(coordinator).toMatch(/mutationCoordinator/u);
		expect(toolFactory).not.toMatch(/new TargetMutationCoordinator/u);
		expect(toolFactory).toMatch(/mutationCoordinator: TargetMutationCoordinator/u);
	});
});
