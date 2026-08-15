#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	extractImportSpecifiers,
	lintSource,
	PACKAGE_DEPENDENCY_MATRIX,
	RUNTIME_DENIED_SYMBOLS,
	RUNTIME_PRIVATE_SUBPATHS,
} from "./boundary-rules.mjs";

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
	for (const packageName of Object.keys(PACKAGE_DEPENDENCY_MATRIX)) {
		const packageRoot = join(packagesRoot, packageName);
		const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
		const files = await filesBelow(packageRoot, (path) => path.endsWith(".ts") || path.endsWith(".mjs"));
		const codaImports = new Map();
		let sourceLines = 0;
		for (const file of files) {
			const source = await readFile(file, "utf8");
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
	return { violations, report };
}

function runSelfTest() {
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
	if (failures.length > 0) {
		for (const failure of failures) console.error(`self-test failed: ${failure.name}`);
		process.exitCode = 1;
		return;
	}
	console.log(`Boundary self-test passed (${fixtures.length} planted violations rejected).`);
}

if (process.argv.includes("--self-test")) {
	runSelfTest();
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
