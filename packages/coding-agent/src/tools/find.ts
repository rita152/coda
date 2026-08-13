import { basename } from "node:path";
import type { AgentTool } from "@coda/agent";
import { Type } from "@coda/ai";
import type { FileSystem } from "../host/file-system.ts";
import type { ProcessRunner } from "../host/process-runner.ts";
import type { Workspace } from "../workspace.ts";
import { runOptionalSearchExecutable, type SearchExecutableRuntime } from "./external-search.ts";
import { toolFailure } from "./failure.ts";
import { displayPath, walkEntries } from "./search.ts";

const FindParameters = Type.Object(
	{
		pattern: Type.String({ minLength: 1 }),
		path: Type.Optional(Type.String({ minLength: 1 })),
		type: Type.Optional(Type.Union([Type.Literal("file"), Type.Literal("directory"), Type.Literal("any")])),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000 })),
	},
	{ additionalProperties: false },
);

function globExpression(glob: string): RegExp {
	let source = "^";
	for (let index = 0; index < glob.length; index++) {
		const character = glob[index]!;
		if (character === "*") {
			if (glob[index + 1] === "*") {
				source += ".*";
				index++;
			} else {
				source += "[^/]*";
			}
		} else if (character === "?") {
			source += "[^/]";
		} else {
			source += character.replace(/[\\^$+.()|[\]{}]/g, "\\$&");
		}
	}
	return new RegExp(`${source}$`);
}

export function createFindTool(options: {
	readonly workspace: Workspace;
	readonly fileSystem: FileSystem;
	readonly processRunner: ProcessRunner;
	readonly runtime: SearchExecutableRuntime;
}): AgentTool<typeof FindParameters> {
	const { fileSystem, workspace } = options;
	return {
		name: "find",
		description: "Find files or directories by glob without invoking a Shell.",
		parameters: FindParameters,
		replaySafety: "safe",
		parallelSafe: true,
		execute: async (arguments_, context) => {
			const expression = globExpression(arguments_.pattern);
			const kind = arguments_.type ?? "file";
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
				executable: "fd",
				args: [
					"--color",
					"never",
					"--hidden",
					"--exclude",
					"node_modules",
					"--glob",
					...(kind === "any" ? [] : ["--type", kind === "file" ? "f" : "d"]),
					"--",
					arguments_.pattern,
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
					return toolFailure("fd search timed out", { code: "timeout", engine: "fd" });
				}
				if (external.exitCode !== 0) {
					return toolFailure(`fd search failed: ${external.stderr.trim() || `exit ${external.exitCode}`}`, {
						code: "search_failed",
						engine: "fd",
						exitCode: external.exitCode,
					});
				}
				const matches: string[] = [];
				for (const line of external.stdout.split(/\r?\n/)) {
					const candidate = line.replace(/[\\/]$/, "");
					if (!candidate) continue;
					const resolved = await workspace.resolvePath(candidate);
					if (!resolved.exists) continue;
					const status = await fileSystem.stat(resolved.canonicalPath);
					if (status.kind !== "file" && status.kind !== "directory") continue;
					if (kind !== "any" && status.kind !== kind) continue;
					const value = `${displayPath(workspace, resolved.canonicalPath)}${status.kind === "directory" ? "/" : ""}`;
					matches.push(value);
				}
				matches.sort((left, right) => left.localeCompare(right));
				const visible = matches.slice(0, limit);
				const truncated = external.truncated || matches.length > visible.length;
				return {
					content: visible.length === 0 ? "(no matches)" : visible.join("\n"),
					observation: { status: "ok", truncated, facts: { count: visible.length, engine: "fd" } },
					details: {
						count: visible.length,
						truncated,
						engine: "fd",
					},
				};
			}
			const entries = await walkEntries(workspace, fileSystem, requestedRoot, context);
			const matchAgainstPath = arguments_.pattern.includes("/");
			const matches = entries.filter((entry) => {
				if (kind !== "any" && entry.kind !== kind) return false;
				return expression.test(matchAgainstPath ? entry.relativePath : basename(entry.relativePath));
			});
			const visible = matches
				.slice(0, limit)
				.map((entry) => (entry.kind === "directory" ? `${entry.relativePath}/` : entry.relativePath));
			const truncated = matches.length > visible.length;
			return {
				content: visible.length === 0 ? "(no matches)" : visible.join("\n"),
				observation: { status: "ok", truncated, facts: { count: visible.length, engine: "node" } },
				details: { count: visible.length, truncated, engine: "node" },
			};
		},
	};
}
