#!/usr/bin/env node

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	extractImportSpecifiers,
	lintSource,
	lintRuntimeModuleGraph,
	PACKAGE_DEPENDENCY_MATRIX,
	RUNTIME_DENIED_SYMBOLS,
	RUNTIME_PRIVATE_SUBPATHS,
} from "./boundary-rules.mjs";
import { discoverWorkspacePackages, workspacePolicyDifferences } from "./workspace-graph.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagesRoot = join(repositoryRoot, "packages");

async function filesBelow(root, predicate) {
	const files = [];
	for (const entry of await readdir(root, { withFileTypes: true })) {
		const path = join(root, entry.name);
		if (entry.isDirectory() && entry.name !== "dist" && entry.name !== "node_modules") {
			files.push(...(await filesBelow(path, predicate)));
		}
		else if (entry.isFile() && predicate(path)) files.push(path);
	}
	return files;
}

async function inspectRepository() {
	const violations = [];
	const report = {};
	const workspaces = await discoverWorkspacePackages(repositoryRoot);
	const policy = workspacePolicyDifferences(workspaces, PACKAGE_DEPENDENCY_MATRIX);
	for (const packageName of policy.missingPolicy) {
		violations.push({
			rule: "workspace-policy-missing",
			file: join(packagesRoot, packageName, "package.json"),
			line: 1,
			message: `${packageName} is a workspace but has no package dependency policy`,
		});
	}
	for (const packageName of policy.stalePolicy) {
		violations.push({
			rule: "workspace-policy-stale",
			file: join(packagesRoot, packageName, "package.json"),
			line: 1,
			message: `${packageName} has package dependency policy but is not a workspace`,
		});
	}
	const runtimeModules = [];
	for (const workspace of workspaces) {
		const packageName = workspace.directoryName;
		const packageRoot = workspace.root;
		const manifest = workspace.manifest;
		if (manifest.name !== `@coda/${packageName}`) {
			violations.push({
				rule: "workspace-manifest-name",
				file: workspace.manifestPath,
				line: 1,
				message: `${packageName} must declare package name @coda/${packageName}`,
			});
		}
		const files = await filesBelow(packageRoot, (path) => path.endsWith(".ts") || path.endsWith(".mjs"));
		const codaImports = new Map();
		let sourceLines = 0;
		for (const file of files) {
			const source = await readFile(file, "utf8");
			if (packageName === "runtime" && dirname(file) === join(packageRoot, "src", "work-graph")) {
				runtimeModules.push({
					name: basename(file, ".ts"),
					file,
					source,
				});
			}
			if (file.includes(`${join(packageRoot, "src")}/`) || file.startsWith(join(packageRoot, "src"))) {
				sourceLines += source.split("\n").length;
			}
			violations.push(...lintSource({ source, file, packageName, packageRoot }));
			for (const { specifier } of extractImportSpecifiers(source)) {
				const match = /^@coda\/([^/]+)/u.exec(specifier);
				if (match && match[1] !== packageName) codaImports.set(match[1], (codaImports.get(match[1]) ?? 0) + 1);
			}
		}
		const declared = Object.keys(manifest.dependencies ?? {})
			.filter((name) => name.startsWith("@coda/"))
			.map((name) => name.slice("@coda/".length))
			.sort();
		const actual = [...codaImports.keys()].sort();
		for (const dependency of actual.filter((name) => !declared.includes(name))) {
			violations.push({
				rule: "undeclared-workspace-dependency",
				file: join(packageRoot, "package.json"),
				line: 1,
				message: `@coda/${dependency} is imported but not declared`,
			});
		}
		for (const dependency of declared.filter((name) => !actual.includes(name))) {
			violations.push({
				rule: "unused-workspace-dependency",
				file: join(packageRoot, "package.json"),
				line: 1,
				message: `@coda/${dependency} is declared but not imported`,
			});
		}
		report[packageName] = { declared, imports: Object.fromEntries([...codaImports].sort()), sourceLines };
	}
	violations.push(...lintRuntimeModuleGraph(runtimeModules));
	return { violations, report };
}

async function runSelfTest() {
	const fixtures = [
		{
			name: "package direction",
			input: { source: 'import "@coda/tui";', file: "/repo/packages/runtime/src/x.ts", packageName: "runtime" },
			rule: "package-direction",
		},
		{
			name: "private subpath",
			input: {
				source: 'import "@coda/runtime/worker-fact";',
				file: "/repo/packages/evals/src/x.ts",
				packageName: "evals",
			},
			rule: "runtime-private-subpath",
		},
		{
			name: "denied symbol",
			input: {
				source: 'import type { WorkerFact } from "@coda/runtime";',
				file: "/repo/packages/evals/src/x.ts",
				packageName: "evals",
			},
			rule: "runtime-denied-symbol",
		},
		{
			name: "relative escape",
			input: {
				source: 'import "../../../other.ts";',
				file: "/repo/packages/evals/src/x.ts",
				packageName: "evals",
				packageRoot: "/repo/packages/evals",
			},
			rule: "relative-package-escape",
		},
		{
			name: "coding-agent module direction",
			input: {
				source: 'import "../session/records.ts";',
				file: "/repo/packages/coding-agent/src/tools/x.ts",
				packageName: "coding-agent",
				packageRoot: "/repo/packages/coding-agent",
			},
			rule: "coding-agent-module-direction",
		},
		{
			name: "coding-agent value direction",
			input: {
				source: 'import { FileSettingsStore } from "../settings/file-settings-store.ts";',
				file: "/repo/packages/coding-agent/src/ui/x.ts",
				packageName: "coding-agent",
				packageRoot: "/repo/packages/coding-agent",
			},
			rule: "coding-agent-value-direction",
		},
		{
			name: "coding-agent UI Session mutation",
			input: {
				source: "session.record(change);",
				file: "/repo/packages/coding-agent/src/ui/chat.ts",
				packageName: "coding-agent",
				packageRoot: "/repo/packages/coding-agent",
			},
			rule: "coding-agent-ui-session-mutation",
		},
	];
	const failures = fixtures.filter(({ input, rule }) => !lintSource(input).some((violation) => violation.rule === rule));
	const barrelViolations = lintRuntimeModuleGraph([
		{
			name: "work-graph-engine",
			file: "/repo/packages/runtime/src/work-graph/work-graph-engine.ts",
			source: 'import { hidden } from "./work-graph-submission.ts";\nvoid hidden;',
		},
		{
			name: "work-graph-submission",
			file: "/repo/packages/runtime/src/work-graph/work-graph-submission.ts",
			source: 'export { hidden } from "./unexpected-owner.ts";',
		},
		{
			name: "unexpected-owner",
			file: "/repo/packages/runtime/src/work-graph/unexpected-owner.ts",
			source: "export const hidden = true;",
		},
	]);
	if (!barrelViolations.some(({ rule, message }) => rule === "runtime-internal-direction" && message.includes("unexpected-owner"))) {
		failures.push({ name: "barrel expansion" });
	}

	const temporaryRoot = await mkdtemp(join(tmpdir(), "coda-boundary-self-test-"));
	try {
		await mkdir(join(temporaryRoot, "packages", "unknown"), { recursive: true });
		await writeFile(
			join(temporaryRoot, "package.json"),
			JSON.stringify({ private: true, workspaces: ["packages/*"] }),
		);
		await writeFile(
			join(temporaryRoot, "packages", "unknown", "package.json"),
			JSON.stringify({ name: "@coda/unknown" }),
		);
		const workspaces = await discoverWorkspacePackages(temporaryRoot);
		const policy = workspacePolicyDifferences(workspaces, PACKAGE_DEPENDENCY_MATRIX);
		if (!policy.missingPolicy.includes("unknown")) failures.push({ name: "unknown workspace" });
	} finally {
		await rm(temporaryRoot, { recursive: true, force: true });
	}
	if (failures.length > 0) {
		for (const failure of failures) console.error(`self-test failed: ${failure.name}`);
		process.exitCode = 1;
		return;
	}
	console.log(`Boundary self-test passed (${fixtures.length + 2} planted violations rejected).`);
}

if (process.argv.includes("--self-test")) {
	await runSelfTest();
} else {
	const { violations, report } = await inspectRepository();
	if (process.argv.includes("--report")) {
		console.log("Package dependency matrix:");
		for (const [name, state] of Object.entries(report)) {
			console.log(
				`${name}: dependencies=[${state.declared.join(", ")}] sourceLines=${state.sourceLines} imports=${JSON.stringify(state.imports)}`,
			);
		}
		console.log(`Runtime private subpaths: ${RUNTIME_PRIVATE_SUBPATHS.join(", ")}`);
		console.log(`Runtime denied symbols: ${RUNTIME_DENIED_SYMBOLS.join(", ")}`);
	}
	for (const violation of violations) {
		console.error(`${relative(repositoryRoot, violation.file)}:${violation.line} [${violation.rule}] ${violation.message}`);
	}
	if (violations.length > 0) {
		console.error(`Boundary check failed with ${violations.length} violation(s).`);
		process.exitCode = 1;
	} else {
		console.log("Boundary check passed.");
	}
}
