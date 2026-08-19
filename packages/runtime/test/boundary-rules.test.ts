import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
// boundary-exception: the runtime regression suite consumes the repository-owned pure boundary rules.
import {
	CODING_AGENT_VALUE_IMPORTS,
	lintSource,
	PACKAGE_DEPENDENCY_MATRIX,
	RUNTIME_DENIED_SYMBOLS,
	RUNTIME_PRIVATE_SUBPATHS,
} from "../../../scripts/boundary-rules.mjs";

describe("repository boundary rules", () => {
	it("keeps coordinator as a thin public-contract delegator", async () => {
		const coordinator = await readFile(new URL("../src/work-graph/coordinator.ts", import.meta.url), "utf8");
		const ports = await readFile(new URL("../src/work-graph/ports.ts", import.meta.url), "utf8");
		expect(coordinator.split("\n").length).toBeLessThanOrEqual(300);
		expect(coordinator).not.toMatch(
			/this\.#options|#appendGraphFacts|#publish\(|#transition\(|#plan\(|#settleItem\(|#runItem\(/u,
		);
		expect(`${coordinator}\n${ports}`).not.toMatch(/WorkGraphFact|WORK_GRAPH_FACT_VERSION|WorkGraphAggregate/u);
	});

	it("keeps private Worker construction behind WorkerLifecycle", async () => {
		const root = new URL("../src/work-graph/", import.meta.url);
		const files = [
			"coordinator.ts",
			"open-coding-agent.ts",
			"work-graph-engine.ts",
			"worker-lifecycle.ts",
			"recovery.ts",
			"admission-controller.ts",
		];
		const importers: string[] = [];
		for (const file of files) {
			const source = await readFile(new URL(file, root), "utf8");
			if (/from "\.\/(?:worker-runtime|delegate-tool)\.ts"/u.test(source)) importers.push(file);
		}
		expect(importers).toEqual(["worker-lifecycle.ts"]);
	});

	it("routes the two undurable Work Item settlements through the projection owner", async () => {
		const engine = await readFile(new URL("../src/work-graph/work-graph-engine.ts", import.meta.url), "utf8");
		expect(engine).not.toMatch(/\bitem\.projection\.(?:state|result)\s*=(?!=|>)/u);
		expect(engine.match(/projectUndurableSettlement\(/gu)).toHaveLength(2);
		const records = await readFile(new URL("../src/work-graph/work-graph-records.ts", import.meta.url), "utf8");
		expect(records.match(/projectUndurableSettlement\(/gu)).toHaveLength(1);
		const recovery = await readFile(new URL("../src/work-graph/recovery.ts", import.meta.url), "utf8");
		expect(recovery).not.toMatch(
			/\bitem\.projection\.(?:state|result|factProjection|cancellationRequested)\s*=(?!=|>)/u,
		);
	});

	it("encodes the package dependency DAG", () => {
		expect(PACKAGE_DEPENDENCY_MATRIX).toEqual({
			ai: [],
			agent: ["ai"],
			"coding-agent": ["agent", "ai", "mcp", "permission", "plugins", "runtime", "sandbox", "skills", "tui"],
			evals: ["agent", "ai", "runtime"],
			mcp: [],
			permission: [],
			plugins: ["mcp", "skills"],
			runtime: ["agent", "ai"],
			sandbox: [],
			skills: [],
			tui: [],
		});
	});

	it("keeps Agent Plugin loading above Runtime and behind one application adapter", () => {
		const codaPackage = (name: string) => `@coda/${name}`;
		expect(CODING_AGENT_VALUE_IMPORTS.plugins).toEqual(["host"]);
		expect(
			Object.entries(CODING_AGENT_VALUE_IMPORTS)
				.filter(([, dependencies]) => dependencies.includes("plugins"))
				.map(([module]) => module),
		).toEqual(["app"]);

		const portableLoader = lintSource({
			source: `import type {} from "${codaPackage("mcp")}";\nimport type {} from "${codaPackage("skills")}";`,
			file: "/repo/packages/plugins/src/loader.ts",
			packageName: "plugins",
			packageRoot: "/repo/packages/plugins",
		});
		expect(portableLoader).toEqual([]);

		const runtime = lintSource({
			source: `import "${codaPackage("plugins")}";`,
			file: "/repo/packages/runtime/src/planted.ts",
			packageName: "runtime",
			packageRoot: "/repo/packages/runtime",
		});
		expect(runtime.map(({ rule }) => rule)).toEqual(["package-direction"]);

		const pluginPolicyLeak = lintSource({
			source: 'import "../settings/types.ts";',
			file: "/repo/packages/coding-agent/src/plugins/adapter.ts",
			packageName: "coding-agent",
			packageRoot: "/repo/packages/coding-agent",
		});
		expect(pluginPolicyLeak.map(({ rule }) => rule)).toEqual(["coding-agent-value-direction"]);
	});

	it("keeps runtime dependencies exactly agent and ai", async () => {
		const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
			dependencies: Record<string, string>;
		};
		expect(Object.keys(manifest.dependencies).sort()).toEqual(["@coda/agent", "@coda/ai"]);
	});

	it("rejects private runtime subpaths and symbols", () => {
		expect(RUNTIME_PRIVATE_SUBPATHS).toContain("@coda/runtime/work-graph-fact");
		expect(RUNTIME_DENIED_SYMBOLS).toContain("WorkerFact");
		const violations = lintSource({
			source: 'import "@coda/runtime/work-graph-fact";\nimport type { WorkerFact } from "@coda/runtime";',
			file: "/repo/packages/evals/src/planted.ts",
			packageName: "evals",
			packageRoot: "/repo/packages/evals",
		});
		expect(violations.map(({ rule }) => rule)).toEqual(["runtime-private-subpath", "runtime-denied-symbol"]);
	});
});
