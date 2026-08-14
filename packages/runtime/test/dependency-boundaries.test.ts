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
		expect(application).toMatch(/openCodingAgentRuntime[\s\S]*from "@coda\/runtime"/u);
		// One shared primary path covers print and interactive; the second opens secondary Sessions.
		expect(application.match(/openCodingAgentRuntime\(\{/gu)).toHaveLength(2);
	});

	it("removes the mutable RunRuntimeSlot Seam", async () => {
		const obsolete = new URL("../../coding-agent/src/runtime/run-runtime-slot.ts", import.meta.url);
		await expect(access(obsolete)).rejects.toThrow();
	});
});
