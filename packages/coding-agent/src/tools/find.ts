import { basename } from "node:path";
import type { AgentTool } from "@coda/agent";
import { Type } from "@coda/ai";
import type { FileSystem } from "../host/file-system.ts";
import { hasPermissionedPathAccess } from "../permissions/file-access.ts";
import type { ModelProcessRunner } from "../permissions/model-process-runner.ts";
import type { PermissionEngine } from "../permissions/permission-engine.ts";
import type { Workspace } from "../workspace.ts";
import { runOptionalSearchExecutable, type SearchExecutableRuntime } from "./external-search.ts";
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
	readonly processRunner: ModelProcessRunner;
	readonly permissions: PermissionEngine;
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
			const root = await workspace.resolvePath(requestedRoot, "read");
			if (!hasPermissionedPathAccess(workspace, root, context.invocationId, "find", "read")) {
				throw new Error(`Path access was not granted: ${root.canonicalPath}`);
			}
			if (!root.exists) throw new Error(`Path does not exist: ${root.canonicalPath}`);
			const protectedRootGranted = workspace.isPathGranted(context.invocationId, "find", "read", root.canonicalPath);
			const protectedExclusions = protectedRootGranted
				? []
				: [
						".git",
						".coda",
						".ssh",
						".env",
						".env.*",
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
					].flatMap((pattern) => ["--exclude", pattern]);
			const external = await runOptionalSearchExecutable({
				executable: "fd",
				args: [
					"--color",
					"never",
					"--hidden",
					...protectedExclusions,
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
				permissions: options.permissions,
				runtime: options.runtime,
				context,
			});
			if (external) {
				if (external.timedOut) throw new Error("fd search timed out");
				if (external.exitCode !== 0) {
					throw new Error(`fd search failed: ${external.stderr.trim() || `exit ${external.exitCode}`}`);
				}
				const matches: string[] = [];
				for (const line of external.stdout.split(/\r?\n/)) {
					const candidate = line.replace(/[\\/]$/, "");
					if (!candidate) continue;
					const resolved = await workspace.resolvePath(candidate, "read");
					if (
						!resolved.exists ||
						!hasPermissionedPathAccess(workspace, resolved, context.invocationId, "find", "read")
					) {
						continue;
					}
					const status = await fileSystem.stat(resolved.canonicalPath);
					if (status.kind !== "file" && status.kind !== "directory") continue;
					if (kind !== "any" && status.kind !== kind) continue;
					const value = `${displayPath(workspace, resolved.canonicalPath)}${status.kind === "directory" ? "/" : ""}`;
					matches.push(value);
				}
				matches.sort((left, right) => left.localeCompare(right));
				const visible = matches.slice(0, limit);
				return {
					content: visible.length === 0 ? "(no matches)" : visible.join("\n"),
					details: {
						count: visible.length,
						truncated: external.truncated || matches.length > visible.length,
						engine: "fd",
					},
				};
			}
			const entries = await walkEntries(workspace, fileSystem, requestedRoot, context, "find");
			const matchAgainstPath = arguments_.pattern.includes("/");
			const matches = entries.filter((entry) => {
				if (kind !== "any" && entry.kind !== kind) return false;
				return expression.test(matchAgainstPath ? entry.relativePath : basename(entry.relativePath));
			});
			const visible = matches
				.slice(0, limit)
				.map((entry) => (entry.kind === "directory" ? `${entry.relativePath}/` : entry.relativePath));
			return {
				content: visible.length === 0 ? "(no matches)" : visible.join("\n"),
				details: { count: visible.length, truncated: matches.length > visible.length, engine: "node" },
			};
		},
	};
}
