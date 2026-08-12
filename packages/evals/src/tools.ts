import type { AgentTool, PolicyGate, ToolExecutionOutput, ToolPolicyRequest } from "@coda/agent";
import { Type } from "@coda/ai";
import type { FixtureCheck, FixtureManifest } from "./fixture-types.ts";
import { type FixtureRepository, normalizeRepositoryPath, RepositoryPathError } from "./repository.ts";

export interface CheckResult {
	readonly id: string;
	readonly passed: boolean;
}

export interface EvaluationToolContext {
	readonly repository: FixtureRepository;
	readonly initialFiles: Readonly<Record<string, string>>;
	readonly expectedFiles: Readonly<Record<string, string>>;
	readonly manifest: FixtureManifest;
	readonly advanceTime: (milliseconds: number) => void;
}

function fileExists(repository: FixtureRepository, path: string): boolean {
	try {
		repository.read(path);
		return true;
	} catch {
		return false;
	}
}

export function evaluateChecks(
	repository: FixtureRepository,
	expectedFiles: Readonly<Record<string, string>>,
	checks: readonly FixtureCheck[],
): readonly CheckResult[] {
	const results: CheckResult[] = [];
	for (const check of checks) {
		let passed = false;
		try {
			switch (check.kind) {
				case "contains":
					passed = repository.read(check.path).includes(check.value);
					break;
				case "not-contains":
					passed = !repository.read(check.path).includes(check.value);
					break;
				case "equals-expected":
					passed = repository.read(check.path) === expectedFiles[check.path];
					break;
				case "absent":
					passed = !fileExists(repository, check.path);
					break;
			}
		} catch {
			passed = false;
		}
		results.push({ id: check.id, passed });
	}
	return results;
}

function testOutput(context: EvaluationToolContext): ToolExecutionOutput {
	const checks = evaluateChecks(context.repository, context.expectedFiles, context.manifest.acceptance.checks);
	const failed = checks.filter((check) => !check.passed);
	const status = failed.length === 0 ? "ok" : "error";
	return {
		content:
			status === "ok"
				? `Acceptance tests passed (${checks.length}/${checks.length}).`
				: `Acceptance tests failed (${checks.length - failed.length}/${checks.length}); failing checks: ${failed.map((check) => check.id).join(", ")}.`,
		observation: {
			status,
			truncated: false,
			facts: { checks: checks.length, failed: failed.length },
		},
	};
}

function withElapsedTime<T>(context: EvaluationToolContext, operation: () => T): T {
	context.advanceTime(context.manifest.toolElapsedMs);
	return operation();
}

const PathParameters = Type.Object({ path: Type.String({ minLength: 1 }) }, { additionalProperties: false });
const WriteParameters = Type.Object(
	{ path: Type.String({ minLength: 1 }), content: Type.String() },
	{ additionalProperties: false },
);
const EmptyParameters = Type.Object({}, { additionalProperties: false });
const BashParameters = Type.Object(
	{
		command: Type.String({ minLength: 1 }),
		sandbox_permissions: Type.Optional(
			Type.Union([
				Type.Literal("use_default"),
				Type.Literal("require_escalated"),
				Type.Literal("with_additional_permissions"),
			]),
		),
		justification: Type.Optional(Type.String()),
		additional_permissions: Type.Optional(
			Type.Object(
				{
					network: Type.Optional(Type.Object({ enabled: Type.Optional(Type.Boolean()) })),
					file_system: Type.Optional(
						Type.Object({
							read: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
							write: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
						}),
					),
				},
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);

function changedPaths(context: EvaluationToolContext): readonly string[] {
	const finalFiles = context.repository.snapshot();
	const paths = new Set([...Object.keys(context.initialFiles), ...Object.keys(finalFiles)]);
	return [...paths].filter((path) => context.initialFiles[path] !== finalFiles[path]).sort();
}

export function createEvaluationTools(context: EvaluationToolContext): readonly AgentTool[] {
	const readFile: AgentTool<typeof PathParameters> = {
		name: "read_file",
		description: "Read one UTF-8 file from the deterministic fixture repository.",
		parameters: PathParameters,
		replaySafety: "safe",
		parallelSafe: true,
		execute: ({ path }) =>
			withElapsedTime(context, (): ToolExecutionOutput => {
				try {
					return {
						content: context.repository.read(path),
						observation: {
							status: "ok" as const,
							truncated: false,
							facts: { path: normalizeRepositoryPath(path) },
						},
					};
				} catch (error) {
					return {
						content: error instanceof Error ? error.message : String(error),
						observation: { status: "error" as const, truncated: false, facts: { reason: "read-failed" } },
					};
				}
			}),
	};
	const listFiles: AgentTool<typeof PathParameters> = {
		name: "list_files",
		description: "List files below a repository-relative path. Use '.' for the whole fixture repository.",
		parameters: PathParameters,
		replaySafety: "safe",
		parallelSafe: true,
		execute: ({ path }) =>
			withElapsedTime(context, (): ToolExecutionOutput => {
				try {
					const files = context.repository.list(path);
					return {
						content: files.length === 0 ? "(no files)" : files.join("\n"),
						observation: { status: "ok" as const, truncated: false, facts: { files: files.length } },
					};
				} catch (error) {
					return {
						content: error instanceof Error ? error.message : String(error),
						observation: { status: "error" as const, truncated: false, facts: { reason: "list-failed" } },
					};
				}
			}),
	};
	const writeFile: AgentTool<typeof WriteParameters> = {
		name: "write_file",
		description: "Replace one UTF-8 file in the deterministic fixture repository with complete content.",
		parameters: WriteParameters,
		replaySafety: "never",
		execute: ({ path, content }) =>
			withElapsedTime(context, (): ToolExecutionOutput => {
				try {
					context.repository.write(path, content);
					return {
						content: `Wrote ${normalizeRepositoryPath(path)} (${Buffer.byteLength(content)} bytes).`,
						observation: {
							status: "ok" as const,
							truncated: false,
							facts: { path: normalizeRepositoryPath(path), bytes: Buffer.byteLength(content) },
						},
					};
				} catch (error) {
					return {
						content: error instanceof Error ? error.message : String(error),
						observation: { status: "error" as const, truncated: false, facts: { reason: "write-failed" } },
					};
				}
			}),
	};
	const runTests: AgentTool<typeof EmptyParameters> = {
		name: "run_tests",
		description: "Run the fixture repository's deterministic acceptance tests.",
		parameters: EmptyParameters,
		replaySafety: "safe",
		execute: () => withElapsedTime(context, () => testOutput(context)),
	};
	const bash: AgentTool<typeof BashParameters> = {
		name: "bash",
		description:
			"Run a simulated repository command. Offline evaluation supports only `npm test` and `git diff --name-only`; it never starts a process or uses the network.",
		parameters: BashParameters,
		replaySafety: "never",
		execute: ({ command }) =>
			withElapsedTime(context, () => {
				if (/^npm (?:run )?test(?:\s|$)/u.test(command)) return testOutput(context);
				if (command.trim() === "git diff --name-only") {
					const files = changedPaths(context);
					return {
						content: files.join("\n") || "(no changes)",
						observation: { status: "ok", truncated: false, facts: { changedFiles: files.length } },
					};
				}
				return {
					content: "Command is unavailable in the deterministic evaluation repository.",
					observation: { status: "error", truncated: false, facts: { reason: "unsupported-command" } },
				};
			}),
	};
	return Object.freeze([listFiles, readFile, writeFile, runTests, bash]);
}

function requestedEscalation(request: ToolPolicyRequest): boolean {
	return (
		request.arguments.sandbox_permissions === "require_escalated" ||
		request.arguments.sandbox_permissions === "with_additional_permissions" ||
		request.arguments.additional_permissions !== undefined
	);
}

function requestedPath(request: ToolPolicyRequest): string | undefined {
	return request.toolName === "read_file" || request.toolName === "write_file"
		? typeof request.arguments.path === "string"
			? request.arguments.path
			: undefined
		: undefined;
}

export function createEvaluationPolicy(manifest: FixtureManifest): PolicyGate {
	const sensitivePaths = new Set((manifest.permissions?.sensitivePaths ?? []).map(normalizeRepositoryPath));
	return {
		check(request) {
			if (requestedEscalation(request)) {
				return { decision: "reject", reason: "The fixture denies the requested Additional Permission." };
			}
			const path = requestedPath(request);
			if (path !== undefined) {
				let normalized: string;
				try {
					normalized = normalizeRepositoryPath(path);
				} catch (error) {
					if (!(error instanceof RepositoryPathError)) throw error;
					return { decision: "reject", reason: error.message };
				}
				if (request.toolName === "read_file" && sensitivePaths.has(normalized)) {
					return { decision: "reject", reason: `Sensitive read denied: ${normalized}` };
				}
				if (request.toolName === "write_file" && manifest.permissions?.denyWrites) {
					return { decision: "reject", reason: "This diagnose-only fixture denies file mutation." };
				}
			}
			return { decision: "allow" };
		},
	};
}
