import type { ApprovalPolicy } from "@coda/permission";
import type { SandboxMode } from "@coda/sandbox";
import type { McpServerConfiguration } from "../mcp/config.ts";
import type { SettingsStore } from "../settings/types.ts";
import {
	canonicalMcpServerConfigurationKey,
	type SkillMcpDependencyPlanDiagnostic,
} from "../skills/mcp-dependencies.ts";
import {
	createSkillMcpDependencyCoordinator,
	type SkillMcpDependencyCoordinator,
	type SkillMcpDependencyCoordinatorOptions,
	type SkillMcpDependencyDecisionChoice,
} from "../skills/mcp-dependency-coordinator.ts";
import type { PrepareExplicitSkillMcpDependencies } from "./prepare-user-prompt.ts";
import type { ApplicationSettingsState } from "./project-runtime.ts";

export interface SkillMcpDependencyInstallDiagnostic {
	readonly code:
		| "skill-mcp-dependency-install-conflict"
		| "skill-mcp-dependency-install-failed"
		| "skill-mcp-dependency-not-installed"
		| "skill-mcp-dependency-rollback-failed";
	readonly severity: "error" | "warning";
	readonly message: string;
	readonly dependency: string;
}

export type ApplicationSkillMcpDependencyDiagnostic =
	| SkillMcpDependencyPlanDiagnostic
	| SkillMcpDependencyInstallDiagnostic;

export interface PersistingSkillMcpDependencyCoordinatorOptions {
	readonly settings: ApplicationSettingsState;
	readonly store: SettingsStore;
	readonly refreshProject: () => Promise<void>;
	readonly configuredServers?: () => readonly McpServerConfiguration[] | Promise<readonly McpServerConfiguration[]>;
	readonly decide: SkillMcpDependencyCoordinatorOptions["decide"];
	readonly reportDiagnostic?: (diagnostic: ApplicationSkillMcpDependencyDiagnostic) => Promise<void> | void;
}

export interface SessionSkillMcpDependencyPreparationOptions
	extends Omit<PersistingSkillMcpDependencyCoordinatorOptions, "decide"> {
	readonly approvalPolicy: ApprovalPolicy | (() => ApprovalPolicy);
	readonly sandboxMode: SandboxMode | (() => SandboxMode);
	readonly capabilityCatalogSnapshot: () => {
		readonly revision: string;
		readonly skills: Awaited<ReturnType<PrepareExplicitSkillMcpDependencies>>["skills"];
		readonly mcp: {
			readonly tools: Awaited<ReturnType<PrepareExplicitSkillMcpDependencies>>["mcpTools"];
		};
	};
	/** Present only for an interactive Session. */
	readonly select?: (
		title: string,
		choices: readonly SkillMcpDependencyDecisionChoice[],
		signal: AbortSignal,
	) => Promise<string | undefined>;
	/** Interactive overlay decision transport; takes precedence over `select`. */
	readonly decide?: SkillMcpDependencyCoordinatorOptions["decide"];
}

export function autoApproveSkillMcpDependencyInstall(
	approvalPolicy: ApprovalPolicy,
	sandboxMode: SandboxMode,
): boolean {
	return approvalPolicy === "never" && sandboxMode === "danger-full-access";
}

function current<T>(value: T | (() => T)): T {
	return typeof value === "function" ? (value as () => T)() : value;
}

/** Creates one Session's dependency consent boundary and coherent-catalog reread. */
export function createSessionSkillMcpDependencyPreparation(
	options: SessionSkillMcpDependencyPreparationOptions,
): PrepareExplicitSkillMcpDependencies {
	const decide: SkillMcpDependencyCoordinatorOptions["decide"] = async (request) => {
		const requiresWorkspacePluginConsent = request.missing.some(({ requestedBy }) =>
			requestedBy.some(({ plugin }) => plugin?.scope === "workspace"),
		);
		if (
			!requiresWorkspacePluginConsent &&
			autoApproveSkillMcpDependencyInstall(current(options.approvalPolicy), current(options.sandboxMode))
		) {
			return "install";
		}
		if (options.decide) return options.decide(request);
		if (!options.select) return "continue";
		const selected = await options.select(`${request.title}\n\n${request.message}`, request.choices, request.signal);
		return selected === "install" ? "install" : "continue";
	};
	const coordinator = createPersistingSkillMcpDependencyCoordinator({
		settings: options.settings,
		store: options.store,
		refreshProject: options.refreshProject,
		...(options.configuredServers ? { configuredServers: options.configuredServers } : {}),
		decide,
		...(options.reportDiagnostic ? { reportDiagnostic: options.reportDiagnostic } : {}),
	});
	return async ({ selectedSkills, signal }) => {
		const result = await coordinator.prepare({ selectedSkills, signal });
		if (result.outcome === "continued" && !options.decide && !options.select && result.canonicalKeys.length > 0) {
			const skillNames = [...new Set(selectedSkills.map(({ qualifiedName }) => qualifiedName))].sort();
			await options.reportDiagnostic?.(
				Object.freeze({
					code: "skill-mcp-dependency-not-installed" as const,
					severity: "warning" as const,
					message: `Selected Skill${skillNames.length === 1 ? "" : "s"} ${skillNames.join(", ")} will continue without required MCP dependencies: ${result.canonicalKeys.join(", ")}`,
					dependency: result.canonicalKeys.join(","),
				}),
			);
		}
		const catalog = options.capabilityCatalogSnapshot();
		return Object.freeze({
			skills: catalog.skills,
			projectRevision: catalog.revision,
			mcpTools: catalog.mcp.tools,
		});
	};
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function sortedServers(servers: readonly McpServerConfiguration[]): readonly McpServerConfiguration[] {
	return Object.freeze(
		[...servers].sort(
			(left, right) =>
				compareText(left.id, right.id) ||
				compareText(canonicalMcpServerConfigurationKey(left), canonicalMcpServerConfigurationKey(right)),
		),
	);
}

async function updateSettings(
	store: SettingsStore,
	mutator: (settings: Awaited<ReturnType<SettingsStore["load"]>>) => Awaited<ReturnType<SettingsStore["load"]>>,
): Promise<Awaited<ReturnType<SettingsStore["load"]>>> {
	if (store.update) return store.update(mutator);
	const next = mutator(await store.load());
	await store.save(next);
	return next;
}

function exactConfiguration(configuration: McpServerConfiguration): string {
	return JSON.stringify(configuration);
}

async function rollbackSkillDependencyAdditions(
	store: SettingsStore,
	additions: readonly McpServerConfiguration[],
): Promise<Awaited<ReturnType<SettingsStore["load"]>>> {
	const exactAdditions = new Set(additions.map(exactConfiguration));
	return updateSettings(store, (settings) =>
		Object.freeze({
			...settings,
			mcpServers: sortedServers(
				(settings.mcpServers ?? []).filter((server) => !exactAdditions.has(exactConfiguration(server))),
			),
		}),
	);
}

/** Adds accepted Skill MCP dependencies without overwriting concurrent settings. */
export function createPersistingSkillMcpDependencyCoordinator(
	options: PersistingSkillMcpDependencyCoordinatorOptions,
): SkillMcpDependencyCoordinator {
	return createSkillMcpDependencyCoordinator({
		configuredServers: options.configuredServers ?? (() => options.settings.current.mcpServers ?? []),
		decide: options.decide,
		reportDiagnostic: options.reportDiagnostic,
		install: async ({ missing, signal }) => {
			signal.throwIfAborted();
			const additions: McpServerConfiguration[] = [];
			const conflicts: string[] = [];
			let committed: Awaited<ReturnType<SettingsStore["load"]>>;
			try {
				committed = await updateSettings(options.store, (latest) => {
					const existing = latest.mcpServers ?? [];
					const existingKeys = new Set(existing.map(canonicalMcpServerConfigurationKey));
					const existingIds = new Map(existing.map((server) => [server.id, server]));
					for (const dependency of missing) {
						if (existingKeys.has(dependency.canonicalKey)) continue;
						if (existingIds.has(dependency.configuration.id)) {
							conflicts.push(dependency.configuration.id);
							continue;
						}
						additions.push(dependency.configuration);
						existingIds.set(dependency.configuration.id, dependency.configuration);
						existingKeys.add(dependency.canonicalKey);
					}
					return additions.length === 0
						? latest
						: Object.freeze({ ...latest, mcpServers: sortedServers([...existing, ...additions]) });
				});
			} catch (error) {
				if (additions.length === 0) {
					await options.reportDiagnostic?.(
						Object.freeze({
							code: "skill-mcp-dependency-install-failed" as const,
							severity: "warning" as const,
							message: `MCP dependency installation was not persisted and will be skipped: ${String(error)}`,
							dependency: missing.map(({ configuration }) => configuration.id).join(","),
						}),
					);
					return false;
				}
				try {
					const reconciliation = await options.store.load();
					const exactAdditions = new Set(additions.map(exactConfiguration));
					const published = (reconciliation.mcpServers ?? []).some((server) =>
						exactAdditions.has(exactConfiguration(server)),
					);
					if (published) {
						const rollback = await rollbackSkillDependencyAdditions(options.store, additions);
						options.settings.current = rollback;
					} else {
						options.settings.current = reconciliation;
					}
				} catch (rollbackError) {
					await options.reportDiagnostic?.(
						Object.freeze({
							code: "skill-mcp-dependency-rollback-failed" as const,
							severity: "error" as const,
							message: `MCP dependency settings persistence failed and its durable state could not be reconciled: ${String(rollbackError)}`,
							dependency: additions.map(({ id }) => id).join(","),
						}),
					);
					throw new AggregateError([error, rollbackError], "MCP dependency installation rollback failed");
				}
				await options.reportDiagnostic?.(
					Object.freeze({
						code: "skill-mcp-dependency-install-failed" as const,
						severity: "warning" as const,
						message: `MCP dependency installation was not persisted and will be skipped: ${String(error)}`,
						dependency: additions.map(({ id }) => id).join(","),
					}),
				);
				return false;
			}
			for (const dependency of [...new Set(conflicts)].sort(compareText)) {
				await options.reportDiagnostic?.(
					Object.freeze({
						code: "skill-mcp-dependency-install-conflict" as const,
						severity: "warning" as const,
						message: `MCP Server "${dependency}" was not installed because that id was configured differently after the Skill prompt`,
						dependency,
					}),
				);
			}
			options.settings.current = committed;
			if (additions.length === 0) return false;
			try {
				signal.throwIfAborted();
				await options.refreshProject();
			} catch (error) {
				try {
					const rollback = await rollbackSkillDependencyAdditions(options.store, additions);
					options.settings.current = rollback;
				} catch (rollbackError) {
					await options.reportDiagnostic?.(
						Object.freeze({
							code: "skill-mcp-dependency-rollback-failed" as const,
							severity: "error" as const,
							message: `MCP dependency refresh failed and settings rollback also failed: ${String(rollbackError)}`,
							dependency: additions.map(({ id }) => id).join(","),
						}),
					);
					throw new AggregateError([error, rollbackError], "MCP dependency installation rollback failed");
				}
				await options.reportDiagnostic?.(
					Object.freeze({
						code: "skill-mcp-dependency-install-failed" as const,
						severity: "warning" as const,
						message: `MCP dependency installation was rolled back after Project refresh failed: ${String(error)}`,
						dependency: additions.map(({ id }) => id).join(","),
					}),
				);
				return false;
			}
			return true;
		},
	});
}
