import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
	CAPABILITIES_MARKERS,
	CORE_COMMANDS_MARKERS,
	checkCapabilityArtifacts,
	generateCapabilityArtifacts,
	replaceGeneratedBlock,
	validateCapabilityManifest,
} from "../scripts/capabilities.ts";
import { CURRENT_SESSION_FORMAT_VERSION } from "../src/session/records.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("generated capability artifacts", () => {
	it("generates the committed manifest and README blocks deterministically", async () => {
		const first = await generateCapabilityArtifacts(repositoryRoot);
		const second = await generateCapabilityArtifacts(repositoryRoot);

		expect(second).toEqual(first);
		expect(await readFile(resolve(repositoryRoot, "capabilities.v1.json"), "utf8")).toBe(first.manifestText);
		expect(await readFile(resolve(repositoryRoot, "packages/coding-agent/README.md"), "utf8")).toBe(first.readmeText);
		expect(await checkCapabilityArtifacts(repositoryRoot)).toEqual([]);
	});

	it("derives current runtime facts instead of repeating known capability prose", async () => {
		const { manifest, readmeText } = await generateCapabilityArtifacts(repositoryRoot);
		const byId = new Map(manifest.capabilities.map((entry) => [entry.id, entry]));

		expect(manifest.runtimeFacts.session.currentFormatVersion).toBe(CURRENT_SESSION_FORMAT_VERSION);
		expect(manifest.runtimeFacts.tools.builtIn).toContain("read_tool_output");
		expect(manifest.runtimeFacts.tools.builtIn).toContain("web_search");
		expect(manifest.runtimeFacts.tools.builtIn).toContain("fetch");
		expect(manifest.runtimeFacts.commands).not.toContainEqual(expect.objectContaining({ name: "compact" }));
		expect(byId.get("coding-agent.context-compaction")).toMatchObject({
			status: "runtime-supported",
			details: { command: null, durableRecordType: "context_compacted" },
		});
		expect(byId.get("coding-agent.sessions")).toMatchObject({
			details: { currentFormatVersion: CURRENT_SESSION_FORMAT_VERSION },
		});
		expect(byId.get("coding-agent.built-in-tools")).toMatchObject({
			details: { names: manifest.runtimeFacts.tools.builtIn },
		});
		expect(
			manifest.capabilities.filter((entry) => entry.status === "deferred").map((entry) => entry.id),
		).not.toContain("coding-agent.context-compaction");
		expect(readmeText).toContain(`Current Session format: v${CURRENT_SESSION_FORMAT_VERSION}`);
		expect(readmeText).toContain("`read_tool_output`");
		expect(readmeText).toContain("`web_search`");
		expect(readmeText).toContain("`fetch`");
	});

	it("conforms to the v1 schema and points to existing evidence", async () => {
		const { manifest } = await generateCapabilityArtifacts(repositoryRoot);

		expect(validateCapabilityManifest(manifest)).toEqual([]);
		expect(new Set(manifest.capabilities.map((entry) => entry.status))).toEqual(
			new Set(["runtime-supported", "type-only", "experimental-private", "deferred"]),
		);
		const evidence = [
			...manifest.sources,
			...manifest.capabilities.flatMap((entry) => [...entry.sources, ...entry.tests]),
		];
		await Promise.all(evidence.map((path) => access(resolve(repositoryRoot, path))));
	});

	it("wires the drift check into the repository check gate", async () => {
		const packageJson = JSON.parse(await readFile(resolve(repositoryRoot, "package.json"), "utf8")) as {
			scripts: Record<string, string>;
		};

		expect(packageJson.scripts["capabilities:update"]).toContain("generate-capabilities.ts --write");
		expect(packageJson.scripts["capabilities:check"]).toContain("generate-capabilities.ts --check");
		expect(packageJson.scripts.check).toContain("npm run capabilities:check");
	});

	it("rejects malformed, duplicate, and out-of-order v1 entries", async () => {
		const { manifest } = await generateCapabilityArtifacts(repositoryRoot);
		const malformed = structuredClone(manifest) as unknown as {
			capabilities: Array<Record<string, unknown>>;
		};
		malformed.capabilities[0]!.status = "unknown";
		malformed.capabilities[1]!.id = String(malformed.capabilities[2]!.id);
		malformed.capabilities.push({ ...malformed.capabilities[2]! });

		const issues = validateCapabilityManifest(malformed);
		expect(issues).toContain("capabilities[0].status is invalid");
		expect(issues.some((issue) => issue.startsWith("capability id is repeated:"))).toBe(true);
		expect(issues).toContain("capabilities must be sorted by status and id");
	});

	it("rewrites only one explicit marker block", () => {
		const source = `before\n${CORE_COMMANDS_MARKERS.start}\nstale\n${CORE_COMMANDS_MARKERS.end}\nafter\n`;
		expect(replaceGeneratedBlock(source, CORE_COMMANDS_MARKERS, "fresh")).toBe(
			`before\n${CORE_COMMANDS_MARKERS.start}\nfresh\n${CORE_COMMANDS_MARKERS.end}\nafter\n`,
		);
		expect(() => replaceGeneratedBlock("no markers", CAPABILITIES_MARKERS, "fresh")).toThrow(
			"Expected exactly one ordered",
		);
	});
});
