import type { CodingPluginId } from "../plugins/types.ts";
import type { CommandFlowMenu, CommandFlowNavigation } from "./flow-types.ts";

export type PluginCommandFlowState = "available" | "disabled" | "enabled" | "invalid" | "update-available";
export type PluginCommandFlowTrust = "not-required" | "trusted" | "untrusted";
export type PluginCommandFlowHealth = "disconnected" | "failed-to-start" | "ready";
export type PluginCommandFlowAction = "install" | "enable" | "disable" | "upgrade" | "remove";

export interface PluginCommandFlowEntry {
	readonly pluginId: CodingPluginId;
	readonly displayName: string;
	readonly description?: string;
	readonly state: PluginCommandFlowState;
	readonly enabled?: boolean;
	readonly validity?: "valid" | "invalid";
	readonly scope?: "user" | "workspace";
	readonly source?: string;
	readonly selectedDigest?: string;
	readonly selectedRevision?: string;
	readonly availableRevision?: string;
	readonly contributions?: {
		readonly skills: readonly string[];
		readonly mcpServers: readonly string[];
	};
	readonly installedVersion?: string;
	readonly availableVersion?: string;
	readonly updateAvailable?: boolean;
	readonly trust?: PluginCommandFlowTrust;
	readonly health?: PluginCommandFlowHealth;
	readonly actions?: readonly PluginCommandFlowAction[];
}

export interface PluginCommandFlowDiagnostic {
	readonly code: string;
	readonly severity: "info" | "warning" | "error";
	readonly message: string;
	readonly pluginId?: CodingPluginId;
	readonly componentName?: string;
}

export interface PluginsCommandFlowSnapshot {
	readonly revision: string;
	readonly plugins: readonly PluginCommandFlowEntry[];
	readonly diagnostics: readonly PluginCommandFlowDiagnostic[];
}

export interface PluginWorkspaceMcpTrustReview {
	readonly workspace: string;
	readonly pluginId: CodingPluginId;
	readonly path: string;
	readonly sha256: string;
}

export type PluginWorkspaceMcpTrustReviewer = (review: PluginWorkspaceMcpTrustReview) => Promise<boolean>;

export interface PluginsCommandFlowOperations {
	install(
		pluginId: CodingPluginId,
		reviewWorkspaceMcp?: PluginWorkspaceMcpTrustReviewer,
	): Promise<PluginsCommandFlowSnapshot>;
	enable(
		pluginId: CodingPluginId,
		reviewWorkspaceMcp?: PluginWorkspaceMcpTrustReviewer,
	): Promise<PluginsCommandFlowSnapshot>;
	disable(
		pluginId: CodingPluginId,
		reviewWorkspaceMcp?: PluginWorkspaceMcpTrustReviewer,
	): Promise<PluginsCommandFlowSnapshot>;
	upgrade(
		pluginId: CodingPluginId,
		reviewWorkspaceMcp?: PluginWorkspaceMcpTrustReviewer,
	): Promise<PluginsCommandFlowSnapshot>;
	remove(
		pluginId: CodingPluginId,
		reviewWorkspaceMcp?: PluginWorkspaceMcpTrustReviewer,
	): Promise<PluginsCommandFlowSnapshot>;
	refresh(reviewWorkspaceMcp?: PluginWorkspaceMcpTrustReviewer): Promise<PluginsCommandFlowSnapshot>;
}

export interface PluginsCommand extends PluginsCommandFlowOperations {
	snapshot(): Promise<PluginsCommandFlowSnapshot>;
}

export interface PluginsCommandFlowOptions {
	readonly snapshot: PluginsCommandFlowSnapshot;
	readonly operations: PluginsCommandFlowOperations;
	readonly selector?: string;
	readonly committedWarning?: string;
}

interface PluginFlowAction {
	readonly id: string;
	readonly label: string;
	readonly description: string;
	readonly operation: (reviewWorkspaceMcp: PluginWorkspaceMcpTrustReviewer) => Promise<PluginsCommandFlowSnapshot>;
}

export function createPluginsCommandFlow(options: PluginsCommandFlowOptions): CommandFlowMenu {
	if (options.selector) {
		const selected = resolveSelector(options.snapshot.plugins, options.selector);
		if (selected.kind === "selected") return pluginDetail(selected.plugin, options);
		if (selected.kind === "ambiguous") return ambiguousSelectorMenu(options.selector, selected.plugins, options);
		return selectorNotFoundMenu(options.selector);
	}
	const plugins = [...options.snapshot.plugins].sort((left, right) => compareText(left.pluginId, right.pluginId));
	return Object.freeze({
		id: "plugins",
		title: "Plugins",
		filterable: true,
		emptyMessage: "No Plugins available",
		items: Object.freeze([
			...(options.committedWarning
				? [
						Object.freeze({
							id: "committed-warning",
							label: "Change committed with warning",
							description: options.committedWarning,
							status: "warning",
						}),
					]
				: []),
			Object.freeze({
				id: "diagnostics",
				label: "Diagnostics",
				description: `${options.snapshot.diagnostics.length} total`,
				onSelect: (navigation: CommandFlowNavigation) =>
					navigation.push(diagnosticsMenu(options.snapshot.diagnostics, "Plugin Diagnostics")),
			}),
			Object.freeze({
				id: "refresh",
				label: "Refresh",
				description: "Reload Plugin Marketplaces and installations",
				onSelect: (navigation: CommandFlowNavigation) =>
					reopen(
						options.operations.refresh(createWorkspaceMcpTrustReviewer(navigation)),
						options.operations,
						navigation,
					),
			}),
			...plugins.map((plugin) =>
				Object.freeze({
					id: plugin.pluginId,
					label: plugin.displayName,
					description: pluginSummary(plugin),
					status: plugin.state,
					onSelect: (navigation: CommandFlowNavigation) => navigation.push(pluginDetail(plugin, options)),
				}),
			),
		]),
	});
}

function pluginDetail(plugin: PluginCommandFlowEntry, options: PluginsCommandFlowOptions): CommandFlowMenu {
	const identity = splitPluginId(plugin.pluginId);
	const directInstallation = identity.marketplace === "workspace-local" || identity.marketplace === "user-local";
	const diagnostics = options.snapshot.diagnostics.filter((diagnostic) => diagnostic.pluginId === plugin.pluginId);
	const actions: PluginFlowAction[] = [];
	const allowedActions = new Set(plugin.actions ?? inferredActions(plugin, directInstallation));
	if (allowedActions.has("install")) {
		actions.push(
			operationItem("install", "Install", "Install and enable this Plugin", (reviewWorkspaceMcp) =>
				options.operations.install(plugin.pluginId, reviewWorkspaceMcp),
			),
		);
	}
	if (allowedActions.has("enable")) {
		actions.push(
			operationItem("enable", "Enable", "Enable this Plugin for future Runs", (reviewWorkspaceMcp) =>
				options.operations.enable(plugin.pluginId, reviewWorkspaceMcp),
			),
		);
	}
	if (allowedActions.has("disable")) {
		actions.push(
			operationItem("disable", "Disable", "Disable this Plugin for future Runs", () =>
				options.operations.disable(plugin.pluginId),
			),
		);
	}
	if (allowedActions.has("upgrade")) {
		actions.push(
			operationItem(
				"upgrade",
				"Upgrade",
				plugin.availableVersion ? `Upgrade to ${plugin.availableVersion}` : "Repair this Plugin installation",
				(reviewWorkspaceMcp) => options.operations.upgrade(plugin.pluginId, reviewWorkspaceMcp),
			),
		);
	}
	if (allowedActions.has("remove")) {
		actions.push(
			operationItem("remove", "Remove", "Remove this installed Plugin", () =>
				options.operations.remove(plugin.pluginId),
			),
		);
	}
	return Object.freeze({
		id: `plugins:detail:${plugin.pluginId}`,
		title: plugin.displayName,
		items: Object.freeze([
			Object.freeze({ id: "plugin-id", label: "Plugin ID", description: plugin.pluginId }),
			Object.freeze({ id: "namespace", label: "Namespace", description: identity.namespace }),
			Object.freeze({ id: "marketplace", label: "Marketplace", description: identity.marketplace }),
			Object.freeze({ id: "status", label: "Status", description: plugin.state }),
			...(plugin.enabled !== undefined
				? [Object.freeze({ id: "enabled", label: "Enabled", description: plugin.enabled ? "yes" : "no" })]
				: []),
			...(plugin.validity
				? [Object.freeze({ id: "validity", label: "Validity", description: plugin.validity })]
				: []),
			...(plugin.scope ? [Object.freeze({ id: "scope", label: "Scope", description: plugin.scope })] : []),
			...(plugin.source ? [Object.freeze({ id: "source", label: "Source", description: plugin.source })] : []),
			...(plugin.selectedDigest
				? [Object.freeze({ id: "digest", label: "Selected digest", description: plugin.selectedDigest })]
				: []),
			...(plugin.selectedRevision
				? [Object.freeze({ id: "revision", label: "Selected revision", description: plugin.selectedRevision })]
				: []),
			...(plugin.availableRevision
				? [
						Object.freeze({
							id: "available-revision",
							label: "Available revision",
							description: plugin.availableRevision,
						}),
					]
				: []),
			...(plugin.installedVersion
				? [Object.freeze({ id: "installed-version", label: "Installed", description: plugin.installedVersion })]
				: []),
			...(plugin.availableVersion
				? [Object.freeze({ id: "available-version", label: "Available", description: plugin.availableVersion })]
				: []),
			...(plugin.updateAvailable !== undefined
				? [
						Object.freeze({
							id: "update",
							label: "Update",
							description: plugin.updateAvailable ? "available" : "current",
						}),
					]
				: []),
			...(plugin.trust ? [Object.freeze({ id: "trust", label: "Trust", description: plugin.trust })] : []),
			...(plugin.health ? [Object.freeze({ id: "health", label: "MCP health", description: plugin.health })] : []),
			...(plugin.contributions
				? [
						Object.freeze({
							id: "skills",
							label: "Skills",
							description: plugin.contributions.skills.join(", ") || "(none)",
						}),
						Object.freeze({
							id: "mcp-servers",
							label: "MCP Servers",
							description: plugin.contributions.mcpServers.join(", ") || "(none)",
						}),
					]
				: []),
			...(directInstallation
				? [
						Object.freeze({
							id: "package-management",
							label: "Package management",
							description: "Update or remove this Plugin from its package directory",
						}),
					]
				: []),
			Object.freeze({
				id: "diagnostics",
				label: "Diagnostics",
				description: `${diagnostics.length} total`,
				onSelect: (navigation: CommandFlowNavigation) =>
					navigation.push(diagnosticsMenu(diagnostics, `${plugin.displayName} Diagnostics`)),
			}),
			...actions.map((item) =>
				Object.freeze({
					id: item.id,
					label: item.label,
					description: item.description,
					onSelect: (navigation: CommandFlowNavigation) =>
						reopen(item.operation(createWorkspaceMcpTrustReviewer(navigation)), options.operations, navigation),
				}),
			),
		]),
	});
}

function inferredActions(
	plugin: PluginCommandFlowEntry,
	directInstallation: boolean,
): readonly PluginCommandFlowAction[] {
	if (plugin.state === "available") return Object.freeze(["install"]);
	if (plugin.state === "invalid") return Object.freeze([]);
	const actions: PluginCommandFlowAction[] = [
		(plugin.enabled ?? (plugin.state === "enabled" || plugin.state === "update-available")) ? "disable" : "enable",
	];
	if (
		!directInstallation &&
		(plugin.updateAvailable === true ||
			Boolean(
				plugin.availableVersion && plugin.installedVersion && plugin.availableVersion !== plugin.installedVersion,
			))
	) {
		actions.push("upgrade");
	}
	if (!directInstallation) actions.push("remove");
	return Object.freeze(actions);
}

function operationItem(
	id: string,
	label: string,
	description: string,
	operation: (reviewWorkspaceMcp: PluginWorkspaceMcpTrustReviewer) => Promise<PluginsCommandFlowSnapshot>,
): PluginFlowAction {
	return Object.freeze({
		id,
		label,
		description,
		operation,
	});
}

function createWorkspaceMcpTrustReviewer(navigation: CommandFlowNavigation): PluginWorkspaceMcpTrustReviewer {
	return (review) =>
		new Promise<boolean>((resolve) => {
			let settled = false;
			const settle = (trusted: boolean): void => {
				if (settled) return;
				settled = true;
				resolve(trusted);
			};
			navigation.push(
				Object.freeze({
					id: "plugins:workspace-mcp-trust",
					title: "Trust Workspace Plugin MCP?",
					onDismiss: () => settle(false),
					items: Object.freeze([
						Object.freeze({
							id: "deny",
							label: "No — leave this MCP disconnected",
							description: "The Plugin remains enabled, but this exact MCP package is not trusted",
							onSelect: (confirmationNavigation: CommandFlowNavigation) => {
								settle(false);
								confirmationNavigation.back();
							},
						}),
						Object.freeze({
							id: "trust",
							label: "Yes — trust this exact Workspace and SHA-256",
							description: "Persist trust, then refresh the current Project before reporting ready",
							onSelect: (confirmationNavigation: CommandFlowNavigation) => {
								settle(true);
								confirmationNavigation.back();
							},
						}),
						Object.freeze({ id: "workspace", label: "Workspace", description: review.workspace }),
						Object.freeze({ id: "plugin-id", label: "Plugin ID", description: review.pluginId }),
						Object.freeze({ id: "path", label: "MCP config", description: review.path }),
						Object.freeze({ id: "sha256", label: "SHA-256", description: review.sha256 }),
					]),
				}),
			);
		});
}

async function reopen(
	operation: Promise<PluginsCommandFlowSnapshot>,
	operations: PluginsCommandFlowOperations,
	navigation: CommandFlowNavigation,
): Promise<void> {
	let snapshot: PluginsCommandFlowSnapshot;
	let committedWarning: string | undefined;
	try {
		snapshot = await operation;
	} catch (error) {
		if (!isCommittedPluginChangeError(error)) throw error;
		snapshot = committedFlowSnapshot(error.committedSnapshot);
		committedWarning = error.message;
	}
	const next = createPluginsCommandFlow({
		snapshot,
		operations,
		...(committedWarning ? { committedWarning } : {}),
	});
	if (navigation.replace) navigation.replace(next);
	else navigation.push(next);
}

interface CommittedPluginChangeError extends Error {
	readonly committed: true;
	readonly code: "plugin_change_notification_failed" | "plugin_post_commit_failed";
	readonly committedSnapshot: {
		readonly revision: string;
		readonly plugins: readonly (Omit<PluginCommandFlowEntry, "state"> & {
			readonly state: PluginCommandFlowState | "installed";
			readonly invalid?: boolean;
			readonly installed?: boolean;
		})[];
		readonly diagnostics: readonly PluginCommandFlowDiagnostic[];
	};
}

function isCommittedPluginChangeError(error: unknown): error is CommittedPluginChangeError {
	if (!(error instanceof Error) || typeof error !== "object" || error === null) return false;
	const candidate = error as Partial<CommittedPluginChangeError>;
	return (
		candidate.committed === true &&
		(candidate.code === "plugin_change_notification_failed" || candidate.code === "plugin_post_commit_failed") &&
		typeof candidate.committedSnapshot?.revision === "string" &&
		Array.isArray(candidate.committedSnapshot.plugins) &&
		Array.isArray(candidate.committedSnapshot.diagnostics)
	);
}

function committedFlowSnapshot(snapshot: CommittedPluginChangeError["committedSnapshot"]): PluginsCommandFlowSnapshot {
	return Object.freeze({
		revision: snapshot.revision,
		plugins: Object.freeze(
			snapshot.plugins.map((plugin) => {
				const invalid = plugin.invalid === true || plugin.state === "invalid";
				const marketplace = splitPluginId(plugin.pluginId).marketplace;
				const direct = marketplace === "workspace-local" || marketplace === "user-local";
				const actions =
					plugin.actions ??
					(invalid && plugin.installed && !direct ? Object.freeze(["upgrade", "remove"] as const) : undefined);
				return Object.freeze({
					pluginId: plugin.pluginId,
					displayName: plugin.displayName,
					...(plugin.description !== undefined ? { description: plugin.description } : {}),
					state: invalid
						? ("invalid" as const)
						: plugin.state === "installed"
							? ("disabled" as const)
							: plugin.state,
					enabled: plugin.enabled,
					validity: plugin.validity ?? (invalid ? ("invalid" as const) : ("valid" as const)),
					scope: plugin.scope,
					...(plugin.selectedDigest !== undefined ? { selectedDigest: plugin.selectedDigest } : {}),
					...(plugin.selectedRevision !== undefined ? { selectedRevision: plugin.selectedRevision } : {}),
					...(plugin.availableRevision !== undefined ? { availableRevision: plugin.availableRevision } : {}),
					...(plugin.contributions !== undefined ? { contributions: plugin.contributions } : {}),
					...(plugin.installedVersion !== undefined ? { installedVersion: plugin.installedVersion } : {}),
					...(plugin.availableVersion !== undefined ? { availableVersion: plugin.availableVersion } : {}),
					...(plugin.updateAvailable !== undefined ? { updateAvailable: plugin.updateAvailable } : {}),
					...(plugin.trust !== undefined ? { trust: plugin.trust } : {}),
					...(plugin.health !== undefined ? { health: plugin.health } : {}),
					...(actions !== undefined ? { actions } : {}),
				});
			}),
		),
		diagnostics: Object.freeze(
			snapshot.diagnostics.map((diagnostic) =>
				Object.freeze({
					code: diagnostic.code,
					severity: diagnostic.severity,
					message: diagnostic.message,
					...(diagnostic.pluginId !== undefined ? { pluginId: diagnostic.pluginId } : {}),
					...(diagnostic.componentName !== undefined ? { componentName: diagnostic.componentName } : {}),
				}),
			),
		),
	});
}

function diagnosticsMenu(diagnostics: readonly PluginCommandFlowDiagnostic[], title: string): CommandFlowMenu {
	return Object.freeze({
		id: `plugins:diagnostics:${normalizeId(title)}`,
		title,
		filterable: true,
		items: Object.freeze(
			diagnostics.length === 0
				? [Object.freeze({ id: "none", label: "No diagnostics" })]
				: diagnostics.map((diagnostic, index) =>
						Object.freeze({
							id: `diagnostic:${index}`,
							label: `${diagnostic.severity}: ${diagnostic.code}`,
							description: diagnostic.componentName
								? `${diagnostic.componentName}: ${diagnostic.message}`
								: diagnostic.message,
						}),
					),
		),
	});
}

type PluginSelectorResolution =
	| { readonly kind: "selected"; readonly plugin: PluginCommandFlowEntry }
	| { readonly kind: "ambiguous"; readonly plugins: readonly PluginCommandFlowEntry[] }
	| { readonly kind: "not-found" };

function resolveSelector(plugins: readonly PluginCommandFlowEntry[], selector: string): PluginSelectorResolution {
	const trimmed = selector.trim();
	const normalized = trimmed.toLocaleLowerCase("en-US");
	if (trimmed.includes("@")) {
		const exact = plugins.find((plugin) => plugin.pluginId === trimmed);
		if (exact) return { kind: "selected", plugin: exact };
		const folded = plugins.filter((plugin) => plugin.pluginId.toLocaleLowerCase("en-US") === normalized);
		if (folded.length === 1) return { kind: "selected", plugin: folded[0]! };
		if (folded.length > 1) {
			return {
				kind: "ambiguous",
				plugins: Object.freeze([...folded].sort((left, right) => compareText(left.pluginId, right.pluginId))),
			};
		}
	}
	const namespaceMatches = plugins.filter(
		(plugin) => splitPluginId(plugin.pluginId).namespace.toLocaleLowerCase("en-US") === normalized,
	);
	if (namespaceMatches.length === 1) return { kind: "selected", plugin: namespaceMatches[0]! };
	if (namespaceMatches.length > 1) {
		return {
			kind: "ambiguous",
			plugins: Object.freeze(
				[...namespaceMatches].sort((left, right) => compareText(left.pluginId, right.pluginId)),
			),
		};
	}
	return { kind: "not-found" };
}

function ambiguousSelectorMenu(
	selector: string,
	plugins: readonly PluginCommandFlowEntry[],
	options: PluginsCommandFlowOptions,
): CommandFlowMenu {
	return Object.freeze({
		id: "plugins:selector-ambiguous",
		title: "Ambiguous Plugin selector",
		items: Object.freeze(
			plugins.map((plugin) =>
				Object.freeze({
					id: plugin.pluginId,
					label: plugin.displayName,
					description: `${plugin.pluginId} matches ${selector}`,
					status: plugin.state,
					onSelect: (navigation: CommandFlowNavigation) => navigation.push(pluginDetail(plugin, options)),
				}),
			),
		),
	});
}

function selectorNotFoundMenu(selector: string): CommandFlowMenu {
	return Object.freeze({
		id: "plugins:selector-not-found",
		title: "Plugin not found",
		items: Object.freeze([
			Object.freeze({
				id: "not-found",
				label: selector,
				description: "No installed or available Plugin matches this selector",
			}),
		]),
	});
}

function splitPluginId(pluginId: CodingPluginId): { readonly namespace: string; readonly marketplace: string } {
	const separator = pluginId.lastIndexOf("@");
	if (separator < 1 || separator === pluginId.length - 1) throw new TypeError(`Invalid PluginId: ${pluginId}`);
	return { namespace: pluginId.slice(0, separator), marketplace: pluginId.slice(separator + 1) };
}

function pluginSummary(plugin: PluginCommandFlowEntry): string {
	const version = plugin.installedVersion ?? plugin.availableVersion;
	const upgrade =
		plugin.updateAvailable === true ||
		(plugin.installedVersion && plugin.availableVersion && plugin.installedVersion !== plugin.availableVersion)
			? " • upgrade available"
			: "";
	const trust = plugin.trust === "untrusted" ? " • untrusted" : "";
	const health = plugin.health && plugin.health !== "ready" ? ` • ${plugin.health}` : "";
	return `${plugin.pluginId}${version ? ` • ${version}` : ""}${upgrade}${trust}${health}${plugin.description ? ` • ${plugin.description}` : ""}`;
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeId(value: string): string {
	return value.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/gu, "-");
}
