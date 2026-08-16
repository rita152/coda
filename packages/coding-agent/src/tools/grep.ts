import type { AgentTool } from "@coda/agent";
import { Type } from "@coda/ai";
import type { FileSystem } from "../host/file-system.ts";
import type { ProcessRunner } from "../host/process-runner.ts";
import type { Workspace } from "../host/workspace.ts";
import { displayWorkspacePath, walkWorkspaceFiles } from "../host/workspace-walker.ts";
import { runOptionalSearchExecutable, type SearchExecutableRuntime } from "./external-search.ts";
import { toolFailure } from "./failure.ts";
import { readSearchableText } from "./search.ts";

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
	readonly processRunner: ProcessRunner;
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
				return toolFailure(`Invalid search pattern: ${error instanceof Error ? error.message : String(error)}`, {
					code: "invalid_pattern",
					pattern: arguments_.pattern,
				});
			}

			const limit = arguments_.limit ?? 200;
			const requestedRoot = arguments_.path ?? ".";
			const root = await workspace.resolvePath(requestedRoot);
			if (!root.exists) {
				return toolFailure(`Path does not exist: ${root.canonicalPath}`, {
					code: "not_found",
					path: root.canonicalPath,
				});
			}
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
				runtime: options.runtime,
				context,
			});
			if (external) {
				if (external.timedOut) {
					return toolFailure("rg search timed out", { code: "timeout", engine: "rg" });
				}
				if (external.exitCode !== 0 && external.exitCode !== 1) {
					return toolFailure(`rg search failed: ${external.stderr.trim() || `exit ${external.exitCode}`}`, {
						code: "search_failed",
						engine: "rg",
						exitCode: external.exitCode,
					});
				}
				const matches: string[] = [];
				let visibleCharacters = 0;
				let truncated = external.truncated;
				for (const line of external.stdout.split(/\r?\n/)) {
					if (!line) continue;
					const match = /^(.+?):(\d+):(\d+):(.*)$/.exec(line);
					if (!match) continue;
					const resolved = await workspace.resolvePath(match[1]!);
					if (!resolved.exists) continue;
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
					const result = `${displayWorkspacePath(workspace, resolved.canonicalPath)}:${lineNumber}:${reportedColumn}:${visibleLine}`;
					if (matches.length >= limit || visibleCharacters + result.length + 1 > MAX_VISIBLE_CHARACTERS) {
						truncated = true;
						break;
					}
					matches.push(result);
					visibleCharacters += result.length + 1;
				}
				return {
					content: matches.length === 0 ? "(no matches)" : matches.join("\n"),
					observation: { status: "ok", truncated, facts: { count: matches.length, engine: "rg" } },
					details: { count: matches.length, truncated, engine: "rg" },
				};
			}
			const files = await walkWorkspaceFiles(workspace, fileSystem, arguments_.path ?? ".", {
				signal: context.signal,
			});
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
				observation: { status: "ok", truncated, facts: { count: matches.length, engine: "node" } },
				details: { count: matches.length, truncated, engine: "node" },
			};
		},
	};
}
