import type { AgentTool } from "@coda/agent";
import { Type } from "@coda/ai";
import type { FileSystem } from "../host/file-system.ts";
import { hasPermissionedPathAccess } from "../permissions/file-access.ts";
import type { ModelProcessRunner } from "../permissions/model-process-runner.ts";
import type { PermissionEngine } from "../permissions/permission-engine.ts";
import type { Workspace } from "../workspace.ts";
import { runOptionalSearchExecutable, type SearchExecutableRuntime } from "./external-search.ts";
import { displayPath, readSearchableText, walkFiles } from "./search.ts";

const GrepParameters = Type.Object(
	{
		pattern: Type.String({ minLength: 1 }),
		path: Type.Optional(Type.String({ minLength: 1 })),
		ignoreCase: Type.Optional(Type.Boolean()),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000 })),
	},
	{ additionalProperties: false },
);

const MAX_VISIBLE_CHARACTERS = 50 * 1024;
const MAX_LINE_CHARACTERS = 500;

export function createGrepTool(options: {
	readonly workspace: Workspace;
	readonly fileSystem: FileSystem;
	readonly processRunner: ModelProcessRunner;
	readonly permissions: PermissionEngine;
	readonly runtime: SearchExecutableRuntime;
}): AgentTool<typeof GrepParameters> {
	const { fileSystem, workspace } = options;
	return {
		name: "grep",
		description: "Search UTF-8 text files with a JavaScript regular expression.",
		parameters: GrepParameters,
		replaySafety: "safe",
		parallelSafe: true,
		execute: async (arguments_, context) => {
			let expression: RegExp;
			try {
				expression = new RegExp(arguments_.pattern, arguments_.ignoreCase ? "gi" : "g");
			} catch (error) {
				throw new Error(`Invalid search pattern: ${error instanceof Error ? error.message : String(error)}`);
			}

			const limit = arguments_.limit ?? 200;
			const requestedRoot = arguments_.path ?? ".";
			const root = await workspace.resolvePath(requestedRoot, "read");
			if (!hasPermissionedPathAccess(workspace, root, context.invocationId, "grep", "read")) {
				throw new Error(`Path access was not granted: ${root.canonicalPath}`);
			}
			if (!root.exists) throw new Error(`Path does not exist: ${root.canonicalPath}`);
			const protectedRootGranted = workspace.isPathGranted(context.invocationId, "grep", "read", root.canonicalPath);
			const protectedExclusions = protectedRootGranted
				? []
				: [
						"--glob",
						"!.git/**",
						"--glob",
						"!.coda/**",
						"--glob",
						"!.ssh/**",
						"--glob",
						"!.env",
						"--glob",
						"!.env.*",
						"--glob",
						".env.example",
						...[
							"id_dsa",
							"id_ecdsa",
							"id_ed25519",
							"id_rsa",
							"*.cer",
							"*.crt",
							"*.key",
							"*.p12",
							"*.pem",
							"*.pfx",
						].flatMap((pattern) => ["--glob", `!${pattern}`]),
					];
			const external = await runOptionalSearchExecutable({
				executable: "rg",
				args: [
					"--line-number",
					"--column",
					"--with-filename",
					"--no-heading",
					"--color",
					"never",
					"--hidden",
					...protectedExclusions,
					"--glob",
					"!node_modules/**",
					...(arguments_.ignoreCase ? ["--ignore-case"] : []),
					"-e",
					arguments_.pattern,
					"--",
					requestedRoot,
				],
				workspaceRoot: workspace.root,
				fileSystem,
				processRunner: options.processRunner,
				permissions: options.permissions,
				runtime: options.runtime,
				context,
			});
			if (external) {
				if (external.timedOut) throw new Error("rg search timed out");
				if (external.exitCode !== 0 && external.exitCode !== 1) {
					throw new Error(`rg search failed: ${external.stderr.trim() || `exit ${external.exitCode}`}`);
				}
				const matches: string[] = [];
				let visibleCharacters = 0;
				let truncated = external.truncated;
				for (const line of external.stdout.split(/\r?\n/)) {
					if (!line) continue;
					const match = /^(.+?):(\d+):(\d+):(.*)$/.exec(line);
					if (!match) continue;
					const resolved = await workspace.resolvePath(match[1]!, "read");
					if (
						!resolved.exists ||
						!hasPermissionedPathAccess(workspace, resolved, context.invocationId, "grep", "read")
					) {
						continue;
					}
					const text = await readSearchableText(fileSystem, resolved.canonicalPath);
					if (text === undefined) continue;
					const lineNumber = Number.parseInt(match[2]!, 10);
					const reportedColumn = Number.parseInt(match[3]!, 10);
					const currentLine = text.split(/\r?\n/)[lineNumber - 1];
					if (currentLine === undefined) continue;
					expression.lastIndex = 0;
					const currentMatch = expression.exec(currentLine);
					if (!currentMatch || currentMatch.index + 1 !== reportedColumn) continue;
					const visibleLine =
						currentLine.length > MAX_LINE_CHARACTERS
							? `${currentLine.slice(0, MAX_LINE_CHARACTERS)}…`
							: currentLine;
					const result = `${displayPath(workspace, resolved.canonicalPath)}:${lineNumber}:${reportedColumn}:${visibleLine}`;
					if (matches.length >= limit || visibleCharacters + result.length + 1 > MAX_VISIBLE_CHARACTERS) {
						truncated = true;
						break;
					}
					matches.push(result);
					visibleCharacters += result.length + 1;
				}
				return {
					content: matches.length === 0 ? "(no matches)" : matches.join("\n"),
					details: { count: matches.length, truncated, engine: "rg" },
				};
			}
			const files = await walkFiles(workspace, fileSystem, arguments_.path ?? ".", context, "grep");
			const matches: string[] = [];
			let visibleCharacters = 0;
			let truncated = false;

			for (const file of files) {
				context.signal.throwIfAborted();
				const text = await readSearchableText(fileSystem, file.canonicalPath);
				if (text === undefined) continue;
				const lines = text.split(/\r?\n/);
				for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
					const line = lines[lineIndex]!;
					expression.lastIndex = 0;
					const match = expression.exec(line);
					if (!match) continue;
					const visibleLine = line.length > MAX_LINE_CHARACTERS ? `${line.slice(0, MAX_LINE_CHARACTERS)}…` : line;
					const result = `${file.relativePath}:${lineIndex + 1}:${match.index + 1}:${visibleLine}`;
					if (matches.length >= limit || visibleCharacters + result.length + 1 > MAX_VISIBLE_CHARACTERS) {
						truncated = true;
						break;
					}
					matches.push(result);
					visibleCharacters += result.length + 1;
				}
				if (truncated) break;
			}

			return {
				content: matches.length === 0 ? "(no matches)" : matches.join("\n"),
				details: { count: matches.length, truncated, engine: "node" },
			};
		},
	};
}
