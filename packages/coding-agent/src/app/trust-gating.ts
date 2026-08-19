import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { McpToolDescriptor } from "@coda/mcp";
import { DEFAULT_SKILL_LIMITS, validateAgentSkill } from "@coda/skills";
import { sanitizeTerminalText } from "@coda/tui";
import { mcpToolsForCommandId } from "../commands/mcp-extensions.ts";
import { skillIdFromCommandId } from "../commands/skill-extensions.ts";
import type { ApplicationIO } from "../host/application-io.ts";
import type { FileSystem } from "../host/file-system.ts";
import type { WorkspaceMcpConfigurationSnapshot, WorkspaceMcpTrustRecord } from "../mcp/config.ts";
import type { CodingPluginMcpSource } from "../plugins/types.ts";
import type { ComposerExtensionReference } from "../session/composer-submission.ts";
import type { TrustedProjectInstructions } from "../settings/project-context.ts";
import type { ProjectTrustRecord, UserSettings } from "../settings/types.ts";
import type { CodingSkillsSnapshot } from "../skills/types.ts";

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

export interface ProjectTrustDecision {
	readonly trusted: boolean;
	readonly updatedSettings?: UserSettings;
	readonly trustRecord?: ProjectTrustRecord;
}

export function projectTrustDecision(input: {
	readonly workspace: string;
	readonly instructions?: TrustedProjectInstructions;
	readonly settings: UserSettings;
	readonly authorized: boolean;
}): ProjectTrustDecision {
	if (!input.instructions) return { trusted: true };
	const alreadyTrusted = (input.settings.projectTrust ?? []).some(
		(entry) =>
			entry.workspace === input.workspace &&
			entry.path === input.instructions?.path &&
			entry.sha256 === input.instructions.sha256,
	);
	if (alreadyTrusted) return { trusted: true };
	if (!input.authorized) return { trusted: false };
	const trustRecord: ProjectTrustRecord = {
		workspace: input.workspace,
		path: input.instructions.path,
		sha256: input.instructions.sha256,
	};
	const retained = (input.settings.projectTrust ?? []).filter((entry) => entry.workspace !== input.workspace);
	return {
		trusted: true,
		trustRecord,
		updatedSettings: {
			...input.settings,
			projectTrust: [...retained, trustRecord].sort((left, right) => left.workspace.localeCompare(right.workspace)),
		},
	};
}

export interface McpTrustDecision {
	readonly trusted: boolean;
	readonly updatedSettings?: UserSettings;
	readonly trustRecord?: WorkspaceMcpTrustRecord;
}

export function mcpTrustDecision(input: {
	readonly workspace: string;
	readonly snapshot?: WorkspaceMcpConfigurationSnapshot;
	readonly settings: UserSettings;
	readonly authorized: boolean;
}): McpTrustDecision {
	if (!input.snapshot || input.snapshot.trust === "trusted") return { trusted: true };
	if (!input.authorized) return { trusted: false };
	const trustRecord: WorkspaceMcpTrustRecord = {
		workspace: input.workspace,
		path: input.snapshot.path,
		sha256: input.snapshot.sha256,
	};
	return {
		trusted: true,
		trustRecord,
		updatedSettings: {
			...input.settings,
			workspaceMcpTrust: [
				...(input.settings.workspaceMcpTrust ?? []).filter(
					(entry) => entry.workspace !== input.workspace || entry.path !== input.snapshot?.path,
				),
				trustRecord,
			].sort((left, right) => compareText(left.workspace, right.workspace) || compareText(left.path, right.path)),
		},
	};
}

export function workspaceMcpReviewText(snapshot: WorkspaceMcpConfigurationSnapshot): string {
	const serverPreview = snapshot.servers.slice(0, 50).map((server) => {
		const target =
			server.transport.kind === "stdio"
				? `${server.transport.command} ${(server.transport.args ?? []).join(" ")}`.trim()
				: server.transport.url;
		return `- ${server.id} (${server.transport.kind}): ${target}`;
	});
	return sanitizeTerminalText(
		[
			"Trust this Workspace MCP configuration?",
			`Path: ${snapshot.path}`,
			`SHA-256: ${snapshot.sha256}`,
			`Servers: ${snapshot.serverCount}`,
			"The exact file hash is stored separately from AGENTS.md and Skills trust; any change requires review again.",
			"Trusting a stdio Server allows Coda to launch its configured executable and call its Tools.",
			"HTTP credentials are resolved outside this file and are never shown here.",
			"",
			...serverPreview,
			...(snapshot.servers.length > serverPreview.length ? ["… (Server preview truncated)"] : []),
		].join("\n"),
	);
}

export function workspacePluginMcpReviewText(source: CodingPluginMcpSource): string {
	const rawByName = new Map(source.plugin.snapshot.mcpServers.map((server) => [server.name, server] as const));
	const serverPreview = source.servers.slice(0, 50).map((server) => {
		const configuration = rawByName.get(server.name)?.configuration;
		const target =
			configuration?.type === "stdio"
				? `${configuration.command} ${(configuration.args ?? []).join(" ")}`.trim()
				: configuration?.type === "streamable-http"
					? configuration.url
					: server.type;
		return `- ${server.id} (${server.type}): ${target}`;
	});
	return sanitizeTerminalText(
		[
			"Trust this Workspace Agent Plugin MCP configuration?",
			`Plugin: ${source.plugin.snapshot.manifest.name} (${source.plugin.slot})`,
			`Path: ${source.path}`,
			`SHA-256: ${source.sha256}`,
			`Servers: ${source.servers.length}`,
			"The exact mcp.json hash is stored separately; any change requires review again.",
			"Trusting a stdio Server allows Coda to launch its configured executable and call its Tools.",
			"Agent Plugin header values are visible package data and are not a portable secret mechanism.",
			"",
			...serverPreview,
			...(source.servers.length > serverPreview.length ? ["… (Server preview truncated)"] : []),
		].join("\n"),
	);
}

export async function validateSkillPath(
	path: string,
	options: {
		readonly fileSystem: FileSystem;
		readonly io: Pick<ApplicationIO, "stdout">;
		readonly runtime: { readonly cwd: string };
	},
	output: "json" | "text",
): Promise<number> {
	const requested = isAbsolute(path) ? path : resolve(options.runtime.cwd, path);
	const canonical = await options.fileSystem.realpath(requested);
	const status = await options.fileSystem.stat(canonical);
	const skillFile = status.kind === "directory" ? join(canonical, "SKILL.md") : canonical;
	if (status.kind !== "directory" && status.kind !== "file") {
		throw new Error(`Skill validation path is not a regular file or directory: ${path}`);
	}
	if (status.kind === "file" && basename(skillFile) !== "SKILL.md") {
		throw new Error("Skill validation file must be named exactly SKILL.md");
	}
	const skillStatus = await options.fileSystem.stat(skillFile);
	if (skillStatus.kind !== "file") throw new Error(`Skill manifest is not a regular file: ${skillFile}`);
	if (skillStatus.size > DEFAULT_SKILL_LIMITS.maxSkillFileBytes) {
		throw new Error(`SKILL.md exceeds the ${DEFAULT_SKILL_LIMITS.maxSkillFileBytes}-byte limit`);
	}
	const bytes = await options.fileSystem.readFile(skillFile);
	if (bytes.byteLength > DEFAULT_SKILL_LIMITS.maxSkillFileBytes) {
		throw new Error(`SKILL.md exceeds the ${DEFAULT_SKILL_LIMITS.maxSkillFileBytes}-byte limit`);
	}
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new Error("SKILL.md is not valid UTF-8");
	}
	const result = validateAgentSkill({
		text,
		directoryName: basename(dirname(skillFile)),
		path: skillFile,
	});
	const validationLine = (value: string) => sanitizeTerminalText(value).replace(/\s+/gu, " ").trim();
	if (output === "json") {
		await options.io.stdout.write(
			`${JSON.stringify({ schemaVersion: 1, type: "skill_validation", path: skillFile, valid: result.valid, diagnostics: result.diagnostics })}\n`,
		);
	} else {
		await options.io.stdout.write(
			`${result.valid ? "Valid Agent Skill" : "Invalid Agent Skill"}: ${validationLine(skillFile)}\n`,
		);
		for (const diagnostic of result.diagnostics) {
			await options.io.stdout.write(
				`${validationLine(`[${diagnostic.severity}] ${diagnostic.code}${diagnostic.field ? ` (${diagnostic.field})` : ""}: ${diagnostic.message}`)}\n`,
			);
		}
	}
	return result.valid ? 0 : 1;
}

export function assertExtensionReferencesAvailable(
	snapshot: CodingSkillsSnapshot,
	mcpTools: readonly McpToolDescriptor[],
	references: readonly ComposerExtensionReference[],
): void {
	for (const reference of references) {
		if (reference.source === "skill") {
			const id = skillIdFromCommandId(reference.commandId);
			const resolved = id ? snapshot.byId.get(id) : undefined;
			if (!resolved) {
				throw new Error(`Selected Skill is no longer available: ${reference.name}`);
			}
			continue;
		}
		if (reference.source === "mcp") {
			if (mcpToolsForCommandId(reference.commandId, mcpTools).length === 0) {
				throw new Error(`Selected MCP Tool is no longer available: ${reference.name}`);
			}
			continue;
		}
		throw new Error(`Extension reference loading is unavailable for source: ${reference.source}`);
	}
}
