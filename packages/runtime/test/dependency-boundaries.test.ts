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

describe("Runtime dependency boundaries", () => {
	it("keeps every Runtime implementation file independent from CLI and TUI Modules", async () => {
		const root = new URL("../src", import.meta.url).pathname;
		for (const file of await sourceFiles(root)) {
			const source = await readFile(file, "utf8");
			expect(source, file).not.toMatch(/@coda\/tui|@coda\/coding-agent|packages\/coding-agent|coding-agent\/src/u);
		}
		const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
			dependencies?: Record<string, string>;
		};
		expect(Object.keys(manifest.dependencies ?? {})).not.toContain("@coda/tui");
		expect(Object.keys(manifest.dependencies ?? {})).not.toContain("@coda/coding-agent");
	});

	it("keeps application.ts as an Adapter over the one public Runtime factory", async () => {
		const application = await readFile(new URL("../../coding-agent/src/application.ts", import.meta.url), "utf8");
		expect(application).not.toMatch(
			/new Agent\b|createCodingTools|ContextWindowController|ContextOverflowRecovery|RunRuntimeSlot|\.attach\(agent/u,
		);
		expect(application).not.toMatch(/openCodingAgentRuntime/u);
		const factory = await readFile(
			new URL("../../coding-agent/src/runtime/workspace-agent-runtime-factory.ts", import.meta.url),
			"utf8",
		);
		expect(factory.match(/openCodingAgentRuntime\(\{/gu)).toHaveLength(1);
		expect(application).toMatch(/createWorkspaceAgentRuntimeFactory/u);
		expect(application.match(/agentRuntimeFactory\.open\(\{/gu)).toHaveLength(2);
	});

	it("keeps the durable input lifecycle owned by each complete Runtime instance", async () => {
		const runtime = await readFile(new URL("../src/coding-agent-runtime.ts", import.meta.url), "utf8");
		const interactive = await readFile(
			new URL("../../coding-agent/src/interactive/input-controller.ts", import.meta.url),
			"utf8",
		);
		expect(runtime).toMatch(/new RuntimeInputQueue/u);
		expect(interactive).not.toMatch(/new RuntimeInputQueue/u);
	});

	it("proves the complete Runtime Seam through the non-CLI evaluation Adapter", async () => {
		const evaluation = await readFile(new URL("../../evals/src/runtime-adapter.ts", import.meta.url), "utf8");
		const suite = await readFile(new URL("../../evals/src/suite.ts", import.meta.url), "utf8");
		expect(evaluation).toMatch(/openCodingAgentRuntime/u);
		expect(evaluation).not.toMatch(/openAgentRuntime/u);
		expect(suite).not.toMatch(/new Agent\b|openAgentRuntime/u);
	});

	it("removes the mutable RunRuntimeSlot Seam", async () => {
		const obsolete = new URL("../../coding-agent/src/runtime/run-runtime-slot.ts", import.meta.url);
		await expect(access(obsolete)).rejects.toThrow();
	});
});
