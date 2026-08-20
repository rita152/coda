import { isAbsolute, relative, resolve, sep } from "node:path";
import type { SkillId } from "@coda/skills";
import type { McpServerConfiguration } from "../mcp/config.ts";
import type { CodingSkillToolDependency, ResolvedCodingSkill } from "./types.ts";

const MCP_SERVER_ID_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/u;

export interface SkillMcpDependencyRequester {
	readonly skillId: SkillId;
	readonly skillName: string;
	readonly qualifiedName: string;
	readonly plugin?: {
		readonly name: string;
		readonly source: string;
		readonly scope: "user" | "workspace";
	};
}

export interface PlannedSkillMcpDependency {
	readonly canonicalKey: string;
	readonly configuration: McpServerConfiguration;
	readonly requestedBy: readonly SkillMcpDependencyRequester[];
}

export interface SkillMcpDependencyPlanDiagnostic {
	readonly code:
		| "skill-mcp-dependency-invalid"
		| "skill-mcp-dependency-name-conflict"
		| "skill-mcp-dependency-oauth-client-managed";
	readonly severity: "warning";
	readonly message: string;
	readonly skillId: SkillId;
	readonly skillName: string;
	readonly dependency: string;
	readonly canonicalKey?: string;
}

export interface SkillMcpDependencyPlan {
	readonly missing: readonly PlannedSkillMcpDependency[];
	readonly canonicalKeys: readonly string[];
	readonly diagnostics: readonly SkillMcpDependencyPlanDiagnostic[];
}

function canonicalMcpKey(transport: "stdio" | "streamable_http", identifier: string, fallback: string): string {
	const normalizedIdentifier = identifier.trim();
	return normalizedIdentifier ? `mcp__${transport}__${normalizedIdentifier}` : fallback;
}

export function canonicalMcpServerConfigurationKey(configuration: McpServerConfiguration): string {
	return configuration.transport.kind === "stdio"
		? canonicalMcpKey("stdio", configuration.transport.command, configuration.id)
		: canonicalMcpKey("streamable_http", configuration.transport.url, configuration.id);
}

function requesterFor(skill: ResolvedCodingSkill): SkillMcpDependencyRequester {
	return Object.freeze({
		skillId: skill.candidate.id,
		skillName: skill.candidate.metadata.name,
		qualifiedName: skill.qualifiedName,
		...(skill.origin.kind === "plugin" && skill.origin.pluginName
			? {
					plugin: Object.freeze({
						name: skill.origin.pluginName,
						source: skill.sourceLabel,
						scope: skill.origin.scope,
					}),
				}
			: {}),
	});
}

function invalidDiagnostic(
	skill: ResolvedCodingSkill,
	dependency: CodingSkillToolDependency,
	message: string,
	canonicalKey?: string,
): SkillMcpDependencyPlanDiagnostic {
	return Object.freeze({
		code: "skill-mcp-dependency-invalid" as const,
		severity: "warning" as const,
		message,
		skillId: skill.candidate.id,
		skillName: skill.candidate.metadata.name,
		dependency: dependency.value,
		...(canonicalKey ? { canonicalKey } : {}),
	});
}

function validHttpUrl(value: string): boolean {
	if (
		value.trim() !== value ||
		!/^(?:http|https):\/\//iu.test(value) ||
		value.includes("\\") ||
		value.includes("#") ||
		/^(?:http|https):\/\/[^/?#]*@/iu.test(value)
	) {
		return false;
	}
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		return false;
	}
	return (parsed.protocol === "http:" || parsed.protocol === "https:") && !parsed.username && !parsed.password;
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function isRelativeCommandPath(identifier: string): boolean {
	return /^(?:\.\.?)[\\/]/u.test(identifier);
}

function dependencyIdentifier(
	skill: ResolvedCodingSkill,
	transport: "stdio" | "streamable_http",
	identifier: string,
): string {
	const pluginRoot = skill.origin.pluginRoot;
	if (
		transport !== "stdio" ||
		skill.origin.kind !== "plugin" ||
		pluginRoot === undefined ||
		!isAbsolute(pluginRoot) ||
		!isRelativeCommandPath(identifier)
	) {
		return identifier;
	}
	return resolve(pluginRoot, identifier);
}

function pluginRelativeCommandEscapes(skill: ResolvedCodingSkill, identifier: string, resolved: string): boolean {
	const pluginRoot = skill.origin.pluginRoot;
	if (
		skill.origin.kind !== "plugin" ||
		pluginRoot === undefined ||
		!isAbsolute(pluginRoot) ||
		!isRelativeCommandPath(identifier)
	) {
		return false;
	}
	const fromRoot = relative(pluginRoot, resolved);
	return fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot);
}

/**
 * Computes the MCP configurations required by explicitly selected Skills.
 *
 * This seam is deliberately pure: callers own consent, persistence, OAuth
 * execution, and refreshing the live MCP catalog.
 */
export function planExplicitSkillMcpDependencies(input: {
	readonly selectedSkills: readonly ResolvedCodingSkill[];
	readonly configuredServers: readonly McpServerConfiguration[];
}): SkillMcpDependencyPlan {
	const configuredCanonicalKeys = new Set(input.configuredServers.map(canonicalMcpServerConfigurationKey));
	const configuredNames = new Set(input.configuredServers.map(({ id }) => id));
	const candidates: PlannedSkillMcpDependency[] = [];
	const diagnostics: SkillMcpDependencyPlanDiagnostic[] = [];
	const selectedSkills = [...input.selectedSkills].sort(
		(left, right) =>
			compareText(left.qualifiedName, right.qualifiedName) || compareText(left.candidate.id, right.candidate.id),
	);
	for (const skill of selectedSkills) {
		for (const dependency of skill.dependencies?.tools ?? []) {
			if (dependency.type.toLowerCase() !== "mcp") continue;
			const transport = dependency.transport?.toLowerCase() ?? "streamable_http";
			if (transport !== "stdio" && transport !== "streamable_http") {
				diagnostics.push(
					invalidDiagnostic(
						skill,
						dependency,
						`Skill "${skill.qualifiedName}" MCP dependency "${dependency.value}" uses unsupported transport "${dependency.transport}"`,
					),
				);
				continue;
			}
			const rawIdentifier = transport === "stdio" ? dependency.command : dependency.url;
			const identifier = rawIdentifier?.trim();
			if (!identifier) {
				diagnostics.push(
					invalidDiagnostic(
						skill,
						dependency,
						transport === "stdio"
							? `Skill "${skill.qualifiedName}" MCP dependency "${dependency.value}" is missing a stdio command`
							: `Skill "${skill.qualifiedName}" MCP dependency "${dependency.value}" is missing a Streamable HTTP URL`,
					),
				);
				continue;
			}
			if (transport === "streamable_http" && !validHttpUrl(rawIdentifier ?? "")) {
				diagnostics.push(
					invalidDiagnostic(
						skill,
						dependency,
						`Skill "${skill.qualifiedName}" MCP dependency "${dependency.value}" URL must be an http(s) URL without credentials or a fragment`,
					),
				);
				continue;
			}
			if (
				transport === "stdio" &&
				skill.origin.kind === "plugin" &&
				isRelativeCommandPath(identifier) &&
				(!skill.origin.pluginRoot || !isAbsolute(skill.origin.pluginRoot))
			) {
				diagnostics.push(
					invalidDiagnostic(
						skill,
						dependency,
						`Skill "${skill.qualifiedName}" MCP dependency "${dependency.value}" relative stdio command cannot be contained without an absolute Agent Plugin root`,
					),
				);
				continue;
			}
			const resolvedIdentifier = dependencyIdentifier(skill, transport, identifier);
			if (transport === "stdio" && pluginRelativeCommandEscapes(skill, identifier, resolvedIdentifier)) {
				diagnostics.push(
					invalidDiagnostic(
						skill,
						dependency,
						`Skill "${skill.qualifiedName}" MCP dependency "${dependency.value}" stdio command resolves outside its Agent Plugin root`,
					),
				);
				continue;
			}
			const canonicalKey = canonicalMcpKey(transport, resolvedIdentifier, dependency.value);
			if (configuredCanonicalKeys.has(canonicalKey)) continue;
			if (!MCP_SERVER_ID_PATTERN.test(dependency.value)) {
				diagnostics.push(
					invalidDiagnostic(
						skill,
						dependency,
						`Skill "${skill.qualifiedName}" MCP dependency name "${dependency.value}" is not a valid MCP Server id`,
						canonicalKey,
					),
				);
				continue;
			}
			if (configuredNames.has(dependency.value)) {
				diagnostics.push(
					Object.freeze({
						code: "skill-mcp-dependency-name-conflict" as const,
						severity: "warning" as const,
						message: `Skill "${skill.qualifiedName}" MCP dependency "${dependency.value}" was not planned because that MCP Server id is already configured differently`,
						skillId: skill.candidate.id,
						skillName: skill.candidate.metadata.name,
						dependency: dependency.value,
						canonicalKey,
					}),
				);
				continue;
			}
			const configuration: McpServerConfiguration =
				transport === "stdio"
					? Object.freeze({
							id: dependency.value,
							transport: Object.freeze({ kind: "stdio" as const, command: resolvedIdentifier }),
						})
					: Object.freeze({
							id: dependency.value,
							transport: Object.freeze({ kind: "http" as const, url: identifier.trim() }),
						});
			const configurationWithOAuth = dependency.oauth
				? Object.freeze({ ...configuration, oauth: Object.freeze({ ...dependency.oauth }) })
				: configuration;
			if (dependency.oauth) {
				diagnostics.push(
					Object.freeze({
						code: "skill-mcp-dependency-oauth-client-managed" as const,
						severity: "warning" as const,
						message: `Skill "${skill.qualifiedName}" MCP dependency "${dependency.value}" requests OAuth callback port ${dependency.oauth.callbackPort}; authentication remains client-managed and was not performed by Coda`,
						skillId: skill.candidate.id,
						skillName: skill.candidate.metadata.name,
						dependency: dependency.value,
						canonicalKey,
					}),
				);
			}
			candidates.push(
				Object.freeze({
					canonicalKey,
					configuration: configurationWithOAuth,
					requestedBy: Object.freeze([requesterFor(skill)]),
				}),
			);
		}
	}
	const byCanonicalKey = new Map<string, PlannedSkillMcpDependency>();
	for (const candidate of candidates.sort(
		(left, right) =>
			compareText(left.canonicalKey, right.canonicalKey) ||
			compareText(left.configuration.id, right.configuration.id) ||
			compareText(left.requestedBy[0]?.qualifiedName ?? "", right.requestedBy[0]?.qualifiedName ?? ""),
	)) {
		const existing = byCanonicalKey.get(candidate.canonicalKey);
		if (!existing) {
			byCanonicalKey.set(candidate.canonicalKey, candidate);
			continue;
		}
		if (
			JSON.stringify(existing.configuration.oauth ?? null) !== JSON.stringify(candidate.configuration.oauth ?? null)
		) {
			for (const requester of candidate.requestedBy) {
				diagnostics.push(
					Object.freeze({
						code: "skill-mcp-dependency-name-conflict" as const,
						severity: "warning" as const,
						message: `Skill "${requester.qualifiedName}" MCP dependency "${candidate.configuration.id}" was not planned because another selected Skill requests conflicting OAuth metadata for the same MCP Server`,
						skillId: requester.skillId,
						skillName: requester.skillName,
						dependency: candidate.configuration.id,
						canonicalKey: candidate.canonicalKey,
					}),
				);
			}
			continue;
		}
		const requesters = new Map(
			[...existing.requestedBy, ...candidate.requestedBy].map((requester) => [
				`${requester.skillId}\0${requester.qualifiedName}`,
				requester,
			]),
		);
		byCanonicalKey.set(
			candidate.canonicalKey,
			Object.freeze({
				...existing,
				requestedBy: Object.freeze(
					[...requesters.values()].sort(
						(left, right) =>
							compareText(left.qualifiedName, right.qualifiedName) || compareText(left.skillId, right.skillId),
					),
				),
			}),
		);
	}
	const byName = new Map<string, PlannedSkillMcpDependency>();
	for (const candidate of byCanonicalKey.values()) {
		if (!byName.has(candidate.configuration.id)) {
			byName.set(candidate.configuration.id, candidate);
			continue;
		}
		for (const requester of candidate.requestedBy) {
			diagnostics.push(
				Object.freeze({
					code: "skill-mcp-dependency-name-conflict" as const,
					severity: "warning" as const,
					message: `Skill "${requester.qualifiedName}" MCP dependency "${candidate.configuration.id}" was not planned because another selected Skill requests that MCP Server id differently`,
					skillId: requester.skillId,
					skillName: requester.skillName,
					dependency: candidate.configuration.id,
					canonicalKey: candidate.canonicalKey,
				}),
			);
		}
	}
	const missing = Object.freeze([...byName.values()]);
	return Object.freeze({
		missing,
		canonicalKeys: Object.freeze(missing.map(({ canonicalKey }) => canonicalKey)),
		diagnostics: Object.freeze(diagnostics),
	});
}
