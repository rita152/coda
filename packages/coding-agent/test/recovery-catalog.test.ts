import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeFileSystem } from "../src/host/node-file-system.ts";
import { createInterruptedToolRecoveryCatalog } from "../src/tools/recovery-catalog.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Interrupted Tool recovery catalog", () => {
	it("exposes only replaySafety safe built-in Tools", async () => {
		const workspacePath = await mkdtemp(join(tmpdir(), "coda-recovery-catalog-"));
		temporaryDirectories.push(workspacePath);
		const tools = await createInterruptedToolRecoveryCatalog({
			workspacePath,
			fileSystem: createNodeFileSystem(),
			processRunner: {
				run: async () => {
					throw new Error("recovery catalog must not spawn processes during construction");
				},
			},
			homeDirectory: workspacePath,
			environment: {},
		});
		expect(tools.map(({ name }) => name)).toEqual(["read", "read_tool_output", "grep", "find", "ls"]);
		expect(tools.every((tool) => tool.replaySafety === "safe")).toBe(true);
	});
});
