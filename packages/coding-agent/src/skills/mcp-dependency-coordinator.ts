import type { McpServerConfiguration } from "../mcp/config.ts";
import {
	type PlannedSkillMcpDependency,
	planExplicitSkillMcpDependencies,
	type SkillMcpDependencyPlanDiagnostic,
} from "./mcp-dependencies.ts";
import type { ResolvedCodingSkill } from "./types.ts";

export type SkillMcpDependencyDecision = "continue" | "install";

export interface SkillMcpDependencyDecisionChoice {
	readonly id: SkillMcpDependencyDecision;
	readonly label: string;
	readonly description: string;
}

export interface SkillMcpDependencyDecisionRequest {
	readonly title: "Install MCP servers?";
	readonly message: string;
	readonly choices: readonly SkillMcpDependencyDecisionChoice[];
	readonly missing: readonly PlannedSkillMcpDependency[];
	readonly signal: AbortSignal;
}

export interface SkillMcpDependencyInstallRequest {
	readonly missing: readonly PlannedSkillMcpDependency[];
	readonly signal: AbortSignal;
}

export interface SkillMcpDependencyPreparationResult {
	readonly outcome: "already-prompted" | "continued" | "installed" | "not-needed";
	readonly canonicalKeys: readonly string[];
	readonly diagnostics: readonly SkillMcpDependencyPlanDiagnostic[];
}

export interface SkillMcpDependencyCoordinator {
	prepare(input: {
		readonly selectedSkills: readonly ResolvedCodingSkill[];
		readonly signal: AbortSignal;
	}): Promise<SkillMcpDependencyPreparationResult>;
}

export interface SkillMcpDependencyCoordinatorOptions {
	readonly configuredServers: () => readonly McpServerConfiguration[] | Promise<readonly McpServerConfiguration[]>;
	readonly decide: (request: SkillMcpDependencyDecisionRequest) => Promise<SkillMcpDependencyDecision>;
	/** Returns false when a recoverable install failure was diagnosed and rolled back. */
	readonly install: (request: SkillMcpDependencyInstallRequest) => Promise<boolean | undefined>;
	readonly reportDiagnostic?: (diagnostic: SkillMcpDependencyPlanDiagnostic) => Promise<void> | void;
}

const DECISION_CHOICES = Object.freeze([
	Object.freeze({
		id: "install" as const,
		label: "Install",
		description: "Install and enable the missing MCP servers in your global config.",
	}),
	Object.freeze({
		id: "continue" as const,
		label: "Continue anyway",
		description: "Skip installation for now and do not show again for these MCP servers in this session.",
	}),
]);

function consentTarget(dependency: PlannedSkillMcpDependency): string {
	return dependency.configuration.transport.kind === "stdio"
		? dependency.configuration.transport.command
		: dependency.configuration.transport.url;
}

function consentRequester(requester: PlannedSkillMcpDependency["requestedBy"][number]): string {
	const skill = `Skill ${requester.qualifiedName}`;
	return requester.plugin ? `Plugin "${requester.plugin.name}" (${requester.plugin.source}), ${skill}` : skill;
}

function consentDependency(dependency: PlannedSkillMcpDependency): string {
	const requesters = dependency.requestedBy.map(consentRequester).join("; ");
	return `${dependency.configuration.id} [${consentTarget(dependency)}; requested by ${requesters}]`;
}

function frozenResult(
	outcome: SkillMcpDependencyPreparationResult["outcome"],
	canonicalKeys: readonly string[],
	diagnostics: readonly SkillMcpDependencyPlanDiagnostic[],
): SkillMcpDependencyPreparationResult {
	return Object.freeze({
		outcome,
		canonicalKeys: Object.freeze([...canonicalKeys]),
		diagnostics: Object.freeze([...diagnostics]),
	});
}

/** Coordinates one Session's Codex-compatible prompt/install suppression policy. */
export function createSkillMcpDependencyCoordinator(
	options: SkillMcpDependencyCoordinatorOptions,
): SkillMcpDependencyCoordinator {
	const promptedCanonicalKeys = new Set<string>();
	let tail: Promise<void> = Promise.resolve();
	const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
		const result = tail.then(operation);
		tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	};
	return Object.freeze({
		prepare: (input: Parameters<SkillMcpDependencyCoordinator["prepare"]>[0]) =>
			serialize(async () => {
				input.signal.throwIfAborted();
				const plan = planExplicitSkillMcpDependencies({
					selectedSkills: input.selectedSkills,
					configuredServers: await options.configuredServers(),
				});
				for (const diagnostic of plan.diagnostics) await options.reportDiagnostic?.(diagnostic);
				input.signal.throwIfAborted();
				if (plan.missing.length === 0) return frozenResult("not-needed", [], plan.diagnostics);
				const missing = Object.freeze(
					plan.missing.filter(({ canonicalKey }) => !promptedCanonicalKeys.has(canonicalKey)),
				);
				if (missing.length === 0) return frozenResult("already-prompted", [], plan.diagnostics);
				const descriptions = missing.map(consentDependency);
				const decision = await options.decide(
					Object.freeze({
						title: "Install MCP servers?" as const,
						message: `The following MCP servers are required by the selected skills but are not installed yet: ${descriptions.join(", ")}. Install them now?`,
						choices: DECISION_CHOICES,
						missing,
						signal: input.signal,
					}),
				);
				input.signal.throwIfAborted();
				const canonicalKeys = Object.freeze(missing.map(({ canonicalKey }) => canonicalKey));
				for (const canonicalKey of canonicalKeys) promptedCanonicalKeys.add(canonicalKey);
				if (decision === "continue") return frozenResult("continued", canonicalKeys, plan.diagnostics);
				const installed = await options.install(Object.freeze({ missing, signal: input.signal }));
				return frozenResult(installed === false ? "continued" : "installed", canonicalKeys, plan.diagnostics);
			}),
	});
}
