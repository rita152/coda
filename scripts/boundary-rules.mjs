import { dirname, extname, relative, resolve, sep } from "node:path";

export const PACKAGE_DEPENDENCY_MATRIX = Object.freeze({
	ai: Object.freeze([]),
	agent: Object.freeze(["ai"]),
	"coding-agent": Object.freeze([
		"agent",
		"ai",
		"mcp",
		"permission",
		"plugins",
		"runtime",
		"sandbox",
		"skills",
		"tui",
	]),
	evals: Object.freeze(["agent", "ai", "runtime"]),
	mcp: Object.freeze([]),
	permission: Object.freeze([]),
	plugins: Object.freeze(["mcp", "skills"]),
	runtime: Object.freeze(["agent", "ai"]),
	sandbox: Object.freeze([]),
	skills: Object.freeze([]),
	tui: Object.freeze([]),
});

export const RUNTIME_PRIVATE_SUBPATHS = Object.freeze([
	"@coda/runtime/worker-fact",
	"@coda/runtime/work-graph-fact",
	"@coda/runtime/work-graph-aggregate",
]);

export const RUNTIME_DENIED_SYMBOLS = Object.freeze([
	"WorkerFact",
	"WorkerControlEvent",
	"WorkGraphFact",
	"WorkGraphAggregate",
	"WorkGraphAggregateGraph",
	"WorkGraphAggregateItem",
	"WorkGraphAggregateSnapshot",
]);

export const RUNTIME_INTERNAL_IMPORTS = Object.freeze({
	"observation-fan-out": Object.freeze([]),
	"durable-graph-store": Object.freeze(["persistence-codec"]),
	"session-registry": Object.freeze([]),
	"publication-sequencer": Object.freeze(["durable-graph-store", "work-graph-fact"]),
	"worker-lifecycle": Object.freeze([
		"durable-graph-store",
		"worker-runtime",
		"delegate-tool",
		"work-graph-fact",
		"work-graph-records",
	]),
	"admission-controller": Object.freeze(["durable-graph-store", "session-registry"]),
	"work-graph-planner": Object.freeze(["work-graph-aggregate", "work-graph-records"]),
	"work-graph-reservation": Object.freeze(["work-graph-fact", "work-graph-records"]),
	"work-graph-submission": Object.freeze(["work-graph-planner", "work-graph-reservation"]),
	"work-graph-scheduler": Object.freeze(["work-graph-records"]),
	"work-graph-delegation": Object.freeze(["work-graph-records"]),
	"work-graph-persistence": Object.freeze(["work-graph-fact", "work-graph-records", "worker-fact"]),
	"work-graph-settlement": Object.freeze(["work-graph-fact", "work-graph-records", "worker-fact"]),
	"work-graph-lifecycle": Object.freeze(["work-graph-persistence", "work-graph-settlement"]),
	"work-graph-engine": Object.freeze([
		"durable-graph-store",
		"admission-controller",
		"worker-lifecycle",
		"publication-sequencer",
		"work-graph-submission",
		"work-graph-planner",
		"work-graph-reservation",
		"work-graph-scheduler",
		"work-graph-delegation",
		"work-graph-lifecycle",
		"work-graph-fact",
		"work-graph-records",
		"work-item-transition",
	]),
	"recovery": Object.freeze([
		"durable-graph-store",
		"session-registry",
		"work-graph-aggregate",
		"work-graph-fact",
		"work-graph-records",
	]),
});

/** Resolved value fan-out includes the barrel modules and everything they re-export. */
export const RUNTIME_RESOLVED_FANOUT_LIMITS = Object.freeze({
	"work-graph-engine": 13,
	"worker-lifecycle": 5,
	recovery: 5,
});

export const CODING_AGENT_FORBIDDEN_EDGES = Object.freeze({
	tools: Object.freeze(["session", "ui"]),
	session: Object.freeze(["tools", "ui", "runtime", "commands"]),
	runtime: Object.freeze(["ui", "commands", "app"]),
});

/** Allowed runtime-value edges between coding-agent's internal modules. Type-only journal vocabulary is erased. */
export const CODING_AGENT_VALUE_IMPORTS = Object.freeze({
	app: Object.freeze([
		"commands",
		"completion",
		"credentials",
		"host",
		"hooks",
		"maintenance",
		"mcp",
		"media",
		"models",
		"plugins",
		"process",
		"run-control",
		"run-evidence",
		"runtime",
		"session",
		"session-history",
		"settings",
		"skills",
		"tools",
		"ui",
	]),
	commands: Object.freeze(["host", "models", "session", "skills", "mcp"]),
	completion: Object.freeze(["host", "process", "run-evidence"]),
	credentials: Object.freeze(["host"]),
	host: Object.freeze([]),
	hooks: Object.freeze(["host"]),
	maintenance: Object.freeze([]),
	mcp: Object.freeze(["host", "settings"]),
	media: Object.freeze([]),
	models: Object.freeze(["host", "credentials"]),
	plugins: Object.freeze(["host"]),
	process: Object.freeze(["host"]),
	"run-control": Object.freeze(["runtime", "host"]),
	"run-evidence": Object.freeze([]),
	runtime: Object.freeze([
		"session",
		"session-history",
		"tools",
		"skills",
		"mcp",
		"models",
		"process",
		"host",
		"run-evidence",
		"settings",
	]),
	// Session's journal deliberately embeds Run Evidence (§3.1 ownership ruling).
	session: Object.freeze(["host", "session-history", "run-evidence"]),
	"session-history": Object.freeze([]),
	settings: Object.freeze(["host"]),
	skills: Object.freeze(["host"]),
	tools: Object.freeze(["host", "process", "session-history"]),
	ui: Object.freeze(["commands", "host", "session", "runtime", "run-evidence", "models", "skills", "mcp", "tools"]),
});

const UI_SESSION_INTERNALS = new Set([
	"file-session-manager",
	"managed-session",
	"records",
	"session-codec-registry",
	"session-journal-store",
	"session-lease",
	"session-recovery",
	"session-schema",
	"media-codec",
]);
const UI_RUNTIME_INTERNALS = new Set([
	"workspace-work-coordinator",
	"workspace-concurrency",
	"file-workspace-persistence",
	"direct-workspace-execution",
	"git-worktree-workspace-execution",
	"capability-contract",
	"model-catalog",
]);

const IMPORT_PATTERN = /(?:\bfrom\s*|\bimport\s*|\brequire\(\s*)["']([^"']+)["']/gu;
const NAMED_RUNTIME_IMPORT_PATTERN = /import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+["']@coda\/runtime["']/gsu;
const MODULE_REFERENCE_PATTERN = /\b(import|export)\s+(type\s+)?(?:[^"'`;]*?\s+from\s+)?["']([^"']+)["']/gu;

export function extractImportSpecifiers(source) {
	return [...source.matchAll(IMPORT_PATTERN)].map((match) => ({
		specifier: match[1],
		index: match.index ?? 0,
	}));
}

/** Extracts static value/type imports and re-exports without erasing their role. */
export function extractModuleReferences(source) {
	return [...source.matchAll(MODULE_REFERENCE_PATTERN)].map((match) => ({
		specifier: match[3],
		index: match.index ?? 0,
		kind: match[1] === "export" ? "reexport" : "import",
		typeOnly: match[2] !== undefined,
	}));
}

function runtimeSiblingName(specifier) {
	return /^\.\/([^/]+)\.ts$/u.exec(specifier)?.[1];
}

/**
 * Validates the resolved Runtime value graph. Re-export targets stay visible and
 * their transitive re-exports are expanded, so adding a barrel cannot lower fan-out.
 */
export function lintRuntimeModuleGraph(modules) {
	const violations = [];
	const byName = new Map(modules.map((module) => [module.name, module]));
	const graph = new Map();
	for (const module of modules) {
		const references = extractModuleReferences(module.source)
			.filter(({ typeOnly }) => !typeOnly)
			.map((reference) => ({ ...reference, target: runtimeSiblingName(reference.specifier) }))
			.filter(({ target }) => target && byName.has(target));
		graph.set(module.name, references);
	}

	const expandReexports = (target, resolved, visiting) => {
		if (resolved.has(target)) return;
		resolved.add(target);
		if (visiting.has(target)) return;
		visiting.add(target);
		for (const reference of graph.get(target) ?? []) {
			if (reference.kind === "reexport") expandReexports(reference.target, resolved, visiting);
		}
		visiting.delete(target);
	};

	for (const [moduleName, allowed] of Object.entries(RUNTIME_INTERNAL_IMPORTS)) {
		const module = byName.get(moduleName);
		if (!module) continue;
		const resolved = new Set();
		for (const reference of graph.get(moduleName) ?? []) {
			expandReexports(reference.target, resolved, new Set());
		}
		for (const dependency of resolved) {
			if (allowed.includes(dependency)) continue;
			violations.push({
				rule: "runtime-internal-direction",
				file: module.file,
				line: 1,
				message: `${moduleName} must not resolve to ${dependency}`,
			});
		}
		const limit = RUNTIME_RESOLVED_FANOUT_LIMITS[moduleName] ?? 4;
		if (resolved.size > limit) {
			violations.push({
				rule: "runtime-resolved-fanout",
				file: module.file,
				line: 1,
				message: `${moduleName} resolves to ${resolved.size} runtime siblings (limit: ${limit})`,
			});
		}
	}

	const visited = new Set();
	const active = [];
	const activeSet = new Set();
	const reportedCycles = new Set();
	const visit = (moduleName) => {
		if (activeSet.has(moduleName)) {
			const start = active.indexOf(moduleName);
			const cycle = [...active.slice(start), moduleName];
			const identity = [...new Set(cycle)].sort().join("\0");
			if (!reportedCycles.has(identity)) {
				reportedCycles.add(identity);
				const module = byName.get(moduleName);
				violations.push({
					rule: "runtime-value-cycle",
					file: module?.file ?? moduleName,
					line: 1,
					message: `runtime value cycle: ${cycle.join(" -> ")}`,
				});
			}
			return;
		}
		if (visited.has(moduleName)) return;
		visited.add(moduleName);
		active.push(moduleName);
		activeSet.add(moduleName);
		for (const reference of graph.get(moduleName) ?? []) visit(reference.target);
		active.pop();
		activeSet.delete(moduleName);
	};
	for (const moduleName of byName.keys()) visit(moduleName);
	return violations;
}

function lineFor(source, index) {
	return source.slice(0, index).split("\n").length;
}

function hasBoundaryException(source, index) {
	const lines = source.slice(0, index).split("\n");
	return lines.slice(-12).join("\n").includes("boundary-exception:");
}

function packageNameFromSpecifier(specifier) {
	const match = /^@coda\/([^/]+)/u.exec(specifier);
	return match?.[1];
}

function isTypeOnlyImport(source, index) {
	const importIndex = source.lastIndexOf("import", index);
	const statementBoundary = Math.max(source.lastIndexOf(";", index), source.lastIndexOf("\n\n", index));
	return importIndex > statementBoundary && /^import\s+type\b/u.test(source.slice(importIndex, index));
}

export function lintSource({ source, file, packageName, packageRoot }) {
	const violations = [];
	for (const imported of extractImportSpecifiers(source)) {
		const dependency = packageNameFromSpecifier(imported.specifier);
		if (dependency && dependency !== packageName) {
			const allowed = PACKAGE_DEPENDENCY_MATRIX[packageName] ?? [];
			if (!allowed.includes(dependency)) {
				violations.push({
					rule: "package-direction",
					file,
					line: lineFor(source, imported.index),
					message: `${packageName} must not import @coda/${dependency}`,
				});
			}
		}
		if (packageName !== "runtime" && RUNTIME_PRIVATE_SUBPATHS.includes(imported.specifier)) {
			violations.push({
				rule: "runtime-private-subpath",
				file,
				line: lineFor(source, imported.index),
				message: `${imported.specifier} is private to @coda/runtime`,
			});
		}
		if ((imported.specifier.startsWith("../") || imported.specifier.startsWith("./")) && packageRoot) {
			const target = resolve(dirname(file), imported.specifier);
			const escaped = relative(packageRoot, target).split(sep).at(0) === "..";
			if (escaped && !hasBoundaryException(source, imported.index)) {
				violations.push({
					rule: "relative-package-escape",
					file,
					line: lineFor(source, imported.index),
					message: `relative import escapes ${packageRoot}`,
				});
			}
		}
	}

	if (packageName !== "runtime") {
		for (const match of source.matchAll(NAMED_RUNTIME_IMPORT_PATTERN)) {
			for (const entry of match[1].split(",")) {
				const symbol = entry.trim().replace(/^type\s+/u, "").split(/\s+as\s+/u)[0]?.trim();
				if (!symbol || !RUNTIME_DENIED_SYMBOLS.includes(symbol)) continue;
				violations.push({
					rule: "runtime-denied-symbol",
					file,
					line: lineFor(source, match.index ?? 0),
					message: `${symbol} is private to @coda/runtime`,
				});
			}
		}
	}

	if (packageName === "runtime" && file.includes(`${sep}src${sep}work-graph${sep}`)) {
		const moduleName = file.slice(file.lastIndexOf(sep) + 1, -extname(file).length);
		const allowed = RUNTIME_INTERNAL_IMPORTS[moduleName];
		if (allowed) {
			const siblingValues = extractImportSpecifiers(source)
				.filter(({ index }) => !isTypeOnlyImport(source, index))
				.map(({ specifier }) => /^\.\/([^/]+)\.ts$/u.exec(specifier)?.[1])
				.filter(Boolean)
				.filter((name) => Object.hasOwn(RUNTIME_INTERNAL_IMPORTS, name) || name === "worker-runtime" || name === "delegate-tool");
			for (const sibling of new Set(siblingValues)) {
				if (!allowed.includes(sibling)) {
					violations.push({
						rule: "runtime-internal-direction",
						file,
						line: 1,
						message: `${moduleName} must not import ${sibling}`,
					});
				}
			}
		}
	}

	if (packageName === "coding-agent") {
		const normalizedFile = file.split(sep).join("/");
		const sourceRelative = packageRoot ? relative(resolve(packageRoot, "src"), file).split(sep).join("/") : "";
		if (sourceRelative === ".." || sourceRelative.startsWith("../")) return violations;
		const sourceModule = sourceRelative.includes("/") ? sourceRelative.split("/")[0] : "app";
		for (const imported of extractImportSpecifiers(source)) {
			if (!imported.specifier.startsWith(".")) continue;
			const target = resolve(dirname(file), imported.specifier).split(sep).join("/");
			const targetRelative = packageRoot
				? relative(resolve(packageRoot, "src"), target).split(sep).join("/")
				: "";
			const targetModule = targetRelative.includes("/") ? targetRelative.split("/")[0] : "app";
			const targetFile = targetRelative.split("/").at(-1)?.replace(/\.ts$/u, "");
			if (!sourceModule || !targetModule) continue;
			if (sourceModule !== targetModule && !isTypeOnlyImport(source, imported.index)) {
				const allowed = CODING_AGENT_VALUE_IMPORTS[sourceModule] ?? [];
				if (!allowed.includes(targetModule)) {
					violations.push({
						rule: "coding-agent-value-direction",
						file,
						line: lineFor(source, imported.index),
						message: `${sourceModule} must not import runtime values from ${targetModule}`,
					});
				}
			}
			const forbidden = CODING_AGENT_FORBIDDEN_EDGES[sourceModule] ?? [];
			if (forbidden.includes(targetModule)) {
				violations.push({
					rule: "coding-agent-module-direction",
					file,
					line: lineFor(source, imported.index),
					message: `${sourceModule} must not import ${targetModule}`,
				});
			}
			if (sourceModule !== "app" && targetModule === "app") {
				violations.push({
					rule: "coding-agent-app-root",
					file,
					line: lineFor(source, imported.index),
					message: `only app may import app modules`,
				});
			}
			if (
				sourceModule === "ui" &&
				((targetModule === "session" && UI_SESSION_INTERNALS.has(targetFile)) ||
					(targetModule === "runtime" && UI_RUNTIME_INTERNALS.has(targetFile)))
			) {
				violations.push({
					rule: "coding-agent-ui-internal",
					file,
					line: lineFor(source, imported.index),
					message: `ui must consume projections instead of ${targetModule}/${targetFile}`,
				});
			}
		}
		if (sourceModule === "ui" && !normalizedFile.endsWith("/src/ui/input-controller.ts")) {
			const mutation = /\bsession\.(?:record|accept)\s*\(/gu.exec(source);
			if (mutation) {
				violations.push({
					rule: "coding-agent-ui-session-mutation",
					file,
					line: lineFor(source, mutation.index),
					message: "only ui/input-controller.ts may mutate a Session",
				});
			}
		}
	}
	return violations;
}
