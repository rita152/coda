import { CORE_COMMANDS } from "../commands/core-commands.ts";
import { AUTH_API_PROTOCOLS } from "../models/types.ts";
import {
	CURRENT_SESSION_FORMAT_VERSION,
	SESSION_RECORD_TYPES,
	SUPPORTED_SESSION_FORMAT_VERSIONS,
} from "../session/records.ts";
import { BUILT_IN_CODING_TOOL_NAMES } from "../tools/contracts.ts";

export const CAPABILITY_MANIFEST_VERSION = 1 as const;

export const CAPABILITY_STATUSES = ["runtime-supported", "type-only", "experimental-private", "deferred"] as const;

export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number];

export interface CapabilityContractEntry {
	readonly id: string;
	readonly package: string;
	readonly status: CapabilityStatus;
	readonly title: string;
	readonly summary: string;
	readonly sources: readonly string[];
	readonly tests: readonly string[];
}

export const RUNTIME_CAPABILITY_FACTS = Object.freeze({
	session: Object.freeze({
		currentFormatVersion: CURRENT_SESSION_FORMAT_VERSION,
		supportedFormatVersions: SUPPORTED_SESSION_FORMAT_VERSIONS,
		recordTypes: SESSION_RECORD_TYPES,
	}),
	tools: Object.freeze({ builtIn: BUILT_IN_CODING_TOOL_NAMES }),
	commands: Object.freeze(
		CORE_COMMANDS.map((command) =>
			Object.freeze({
				name: command.name,
				aliases: Object.freeze([...(command.aliases ?? [])]),
				visible: command.visibleInPalette !== false,
				arguments: command.arguments.kind,
			}),
		),
	),
	modelApiProtocols: AUTH_API_PROTOCOLS,
});

/**
 * The single hand-reviewed product capability classification. Executable facts
 * such as format versions, Tool names, commands, protocols, type-only exports,
 * and package visibility are joined by the generator from their owning runtime
 * contracts instead of being repeated here or in README prose.
 */
export const CODA_CAPABILITY_CONTRACT = Object.freeze([
	capability({
		id: "agent.run-runtime",
		package: "@coda/agent",
		status: "runtime-supported",
		title: "Agent runtime",
		summary:
			"In-memory Runs and Turns, immutable events, Tool execution, cancellation, Steering and Follow-up queues, and opt-in whole-Turn retry.",
		sources: ["packages/agent/src/agent.ts", "packages/agent/src/types.ts"],
		tests: ["packages/agent/test/agent-run.test.ts", "packages/agent/test/input-queues.test.ts"],
	}),
	capability({
		id: "runtime.work-graph-orchestration",
		package: "@coda/runtime",
		status: "runtime-supported",
		title: "Durable Work Graph orchestration",
		summary:
			"A closed submit/observe/close Interface coordinates durable Work Graphs, deterministic DAG scheduling, bounded parallel Work Items, isolated Worker Sessions and observations, ordered causal control, cancellation, recovery, structured results, and pluggable Direct or Git-worktree Workspace Publication while keeping serial Worker Runtimes private.",
		sources: [
			"packages/runtime/src/index.ts",
			"packages/runtime/src/run-capabilities.ts",
			"packages/runtime/src/work-graph/coordinator.ts",
			"packages/runtime/src/work-graph/types.ts",
			"packages/coding-agent/src/runtime/direct-workspace-execution.ts",
			"packages/coding-agent/src/runtime/file-workspace-persistence.ts",
			"packages/coding-agent/src/runtime/git-worktree-workspace-execution.ts",
			"packages/coding-agent/src/runtime/workspace-input-resources.ts",
			"packages/coding-agent/src/runtime/workspace-work-coordinator.ts",
		],
		tests: [
			"packages/runtime/test/dependency-boundaries.test.ts",
			"packages/runtime/test/public-contract.test.ts",
			"packages/runtime/test/run-capabilities.test.ts",
			"packages/runtime/test/work-graph.test.ts",
			"packages/coding-agent/test/direct-workspace-execution.test.ts",
			"packages/coding-agent/test/file-workspace-persistence.test.ts",
			"packages/coding-agent/test/git-worktree-work-graph.e2e.test.ts",
			"packages/coding-agent/test/git-worktree-workspace-execution.test.ts",
			"packages/coding-agent/test/session-work-controller.test.ts",
			"packages/coding-agent/test/workspace-input-resources.test.ts",
			"packages/coding-agent/test/workspace-work-sessions.test.ts",
		],
	}),
	capability({
		id: "agent.run-budget",
		package: "@coda/agent",
		status: "runtime-supported",
		title: "Bounded Agent Runs",
		summary:
			"Immutable per-Run budgets cap Turns, Model Attempts, Tool invocations, elapsed time, token and USD usage, and repeated equivalent Tool batches with explicit exhaustion events.",
		sources: ["packages/agent/src/run-budget.ts", "packages/agent/src/agent.ts", "packages/agent/src/types.ts"],
		tests: ["packages/agent/test/run-budget.test.ts", "packages/agent/test/reducer-replay.test.ts"],
	}),
	capability({
		id: "ai.model-access",
		package: "@coda/ai",
		status: "runtime-supported",
		title: "Model access",
		summary:
			"OpenCode Go and custom API-key Providers, streaming text, Thinking, Tool calls, structured Diagnostics, cancellation, and explicit model-catalog refresh.",
		sources: ["packages/ai/src/providers/opencode-go.ts", "packages/coding-agent/src/models/provider-manager.ts"],
		tests: ["packages/ai/test/opencode-go-provider.test.ts", "packages/coding-agent/test/provider-manager.test.ts"],
	}),
	capability({
		id: "coding-agent.provider-metadata",
		package: "@coda/coding-agent",
		status: "runtime-supported",
		title: "Custom Provider metadata",
		summary:
			"Custom Provider models retain configured context, output, image-input, reasoning, status, and tiered-cost metadata across settings, catalog refresh, selection, and runtime consumers.",
		sources: [
			"packages/coding-agent/src/models/custom-model-metadata.ts",
			"packages/coding-agent/src/models/model-metadata.ts",
			"packages/coding-agent/src/app/file-settings-store.ts",
		],
		tests: [
			"packages/coding-agent/test/provider-manager.test.ts",
			"packages/coding-agent/test/settings-store.test.ts",
			"packages/coding-agent/test/model-command-flow.test.ts",
		],
	}),
	capability({
		id: "coding-agent.built-in-tools",
		package: "@coda/coding-agent",
		status: "runtime-supported",
		title: "Built-in Tools",
		summary:
			"Workspace-relative and absolute-path reading, search, atomic single-file and structured multi-file mutation, direct host Shell execution, and recoverable continuation of omitted Tool output.",
		sources: [
			"packages/coding-agent/src/tools/index.ts",
			"packages/coding-agent/src/tools/mutation-contract.ts",
			"packages/coding-agent/src/tools/patch.ts",
		],
		tests: [
			"packages/coding-agent/test/read-tool.test.ts",
			"packages/coding-agent/test/search-tools.test.ts",
			"packages/coding-agent/test/mutation-tools.test.ts",
			"packages/coding-agent/test/patch-parser.test.ts",
			"packages/coding-agent/test/patch-tool.test.ts",
			"packages/coding-agent/test/bash-tool.test.ts",
		],
	}),
	capability({
		id: "coding-agent.session-history",
		package: "@coda/coding-agent",
		status: "runtime-supported",
		title: "Bounded Session history recovery",
		summary:
			"The `read_session_history` Tool pages through committed historical Messages with bounded, cursor-based windows and authoritative Observations without exposing pending Draft state.",
		sources: [
			"packages/coding-agent/src/session-history/reader.ts",
			"packages/coding-agent/src/tools/read-session-history.ts",
			"packages/coding-agent/src/session/managed-session.ts",
		],
		tests: [
			"packages/coding-agent/test/session-history-reader.test.ts",
			"packages/coding-agent/test/managed-session.test.ts",
		],
	}),
	capability({
		id: "coding-agent.process-sessions",
		package: "@coda/coding-agent",
		status: "runtime-supported",
		title: "Long-running process Sessions",
		summary:
			"Process-local background Shell Sessions execute directly on the host and support bounded start, poll, stdin, stop, and recoverable omitted output.",
		sources: [
			"packages/coding-agent/src/process/process-session-manager.ts",
			"packages/coding-agent/src/process/tools.ts",
			"packages/coding-agent/src/host/node-process-session-runner.ts",
		],
		tests: [
			"packages/coding-agent/test/process-session-manager.test.ts",
			"packages/coding-agent/test/process-tools.test.ts",
		],
	}),
	capability({
		id: "coding-agent.context-compaction",
		package: "@coda/runtime",
		status: "runtime-supported",
		title: "Durable Context Compaction",
		summary:
			"Private Worker Runtimes automatically compact at safe model-call boundaries and durably persist Tool-pair-safe Compaction Checkpoints before replacing the model-visible Context Window.",
		sources: [
			"packages/runtime/src/context-window/context-window.ts",
			"packages/runtime/src/work-graph/worker-runtime.ts",
			"packages/coding-agent/src/session/records.ts",
		],
		tests: [
			"packages/coding-agent/test/compaction.test.ts",
			"packages/coding-agent/test/context-overflow.test.ts",
			"packages/runtime/test/context-window.test.ts",
		],
	}),
	capability({
		id: "coding-agent.overflow-fallback",
		package: "@coda/coding-agent",
		status: "runtime-supported",
		title: "Context Overflow fallback",
		summary:
			"After local and Provider overflow recovery is exhausted, interactive mode can open a fresh empty Session in the same Workspace without inheriting Messages, summaries, media, queues, Tool state, or Run evidence.",
		sources: [
			"packages/runtime/src/context-window/overflow-recovery.ts",
			"packages/coding-agent/src/ui/run-interactive.ts",
			"packages/coding-agent/src/ui/workspace-session-panes.ts",
		],
		tests: [
			"packages/runtime/test/context-overflow-recovery.test.ts",
			"packages/coding-agent/test/context-overflow-fallback.test.ts",
			"packages/coding-agent/test/workspace-session-panes.test.ts",
		],
	}),
	capability({
		id: "coding-agent.run-evidence",
		package: "@coda/coding-agent",
		status: "runtime-supported",
		title: "Objective Run evidence",
		summary:
			"Completed Runs project bounded, sanitized evidence from lifecycle events, authoritative Tool Observations, generic mutation facts, and the final Git-visible Workspace diff, separating completeness, changed-path provenance, terminal/recovered/open failures, pending operations, retries, token usage, and price-data completeness.",
		sources: [
			"packages/coding-agent/src/run-evidence/contracts.ts",
			"packages/coding-agent/src/run-evidence/failure-semantics.ts",
			"packages/coding-agent/src/run-evidence/observation-semantics.ts",
			"packages/coding-agent/src/run-evidence/run-evidence.ts",
			"packages/coding-agent/src/completion/workspace-diff.ts",
			"packages/coding-agent/src/run-evidence/presentation.ts",
			"packages/coding-agent/src/session/managed-session.ts",
		],
		tests: [
			"packages/coding-agent/test/read-tool.test.ts",
			"packages/coding-agent/test/run-evidence.test.ts",
			"packages/coding-agent/test/run-evidence-presentation.test.ts",
			"packages/coding-agent/test/workspace-diff.test.ts",
		],
	}),
	capability({
		id: "coding-agent.completion-gate",
		package: "@coda/coding-agent",
		status: "runtime-supported",
		title: "Evidence-backed print completion",
		summary:
			"Print and JSON Runs emit a versioned completion disposition that keeps lifecycle, evidence completeness, local verification, and hidden-verifier scope separate, with one bounded repair Steering by default.",
		sources: [
			"packages/coding-agent/src/completion/completion-gate.ts",
			"packages/coding-agent/src/completion/completion-controller.ts",
			"packages/coding-agent/src/completion/run-evidence-adapter.ts",
			"packages/coding-agent/src/completion/workspace-evidence.ts",
		],
		tests: [
			"packages/coding-agent/test/completion-gate.test.ts",
			"packages/coding-agent/test/completion-application.test.ts",
		],
	}),
	capability({
		id: "coding-agent.media",
		package: "@coda/coding-agent",
		status: "runtime-supported",
		title: "Media Assets",
		summary:
			"Bounded image Attachments use content-addressed Session storage, model-ready renditions, Kitty previews, and a system-viewer fallback.",
		sources: ["packages/coding-agent/src/media/media-library.ts", "packages/tui/src/terminal-image-surface.ts"],
		tests: [
			"packages/coding-agent/test/media-library.test.ts",
			"packages/coding-agent/test/interactive-media.test.ts",
		],
	}),
	capability({
		id: "coding-agent.mcp-host",
		package: "@coda/mcp",
		status: "runtime-supported",
		title: "MCP Host",
		summary:
			"MCP Tools over stdio and Streamable HTTP with version negotiation, Workspace trust, immutable Run catalogs, progress, cancellation, subscriptions, and form or URL Elicitation.",
		sources: [
			"packages/mcp/src/host.ts",
			"packages/coding-agent/src/mcp/registry.ts",
			"packages/coding-agent/src/mcp/run-capability.ts",
		],
		tests: ["packages/mcp/test/host.test.ts", "packages/coding-agent/test/mcp/application.test.ts"],
	}),
	capability({
		id: "coding-agent.credential-storage",
		package: "@coda/coding-agent",
		status: "runtime-supported",
		title: "Secure platform Credential storage",
		summary:
			"API credentials use macOS Keychain or Linux Secret Service when available, never persist plaintext fallback secrets, redact helper failures, and otherwise remain process-local.",
		sources: [
			"packages/coding-agent/src/credentials/node-credential-store.ts",
			"packages/coding-agent/src/credentials/keychain-store.ts",
			"packages/coding-agent/src/credentials/secret-service-store.ts",
			"packages/coding-agent/src/credentials/secret-tool-client.ts",
		],
		tests: [
			"packages/coding-agent/test/credential-store.test.ts",
			"packages/coding-agent/test/secret-service-credential-store.test.ts",
		],
	}),
	capability({
		id: "coding-agent.prompt-events",
		package: "@coda/coding-agent",
		status: "runtime-supported",
		title: "Prompt and event formats",
		summary:
			"Deterministic per-Run System Prompt snapshots and stable opt-in JSONL v2 Agent events with optional media data.",
		sources: ["packages/runtime/src/prompt/prompt-builder.ts", "packages/runtime/src/work-graph/worker-runtime.ts"],
		tests: ["packages/runtime/test/prompt-builder.test.ts", "packages/coding-agent/test/application-print.test.ts"],
	}),
	capability({
		id: "coding-agent.sessions",
		package: "@coda/coding-agent",
		status: "runtime-supported",
		title: "Durable Sessions",
		summary:
			"Append-only workspace-scoped Sessions restore Messages, queues, Composer and Extension facts, Media Assets, Model selection, Tool Observations, and Compaction Checkpoints.",
		sources: [
			"packages/coding-agent/src/session/file-session-manager.ts",
			"packages/coding-agent/src/session/records.ts",
			"packages/coding-agent/src/session/session-codec-registry.ts",
			"packages/coding-agent/src/session/session-journal-store.ts",
			"packages/coding-agent/src/session/session-lease.ts",
			"packages/coding-agent/src/session/session-recovery.ts",
			"packages/coding-agent/src/session/session-schema.ts",
		],
		tests: ["packages/coding-agent/test/session-file.test.ts", "packages/coding-agent/test/session-schema.test.ts"],
	}),
	capability({
		id: "coding-agent.skills",
		package: "@coda/skills",
		status: "runtime-supported",
		title: "Agent Skills",
		summary:
			"Agent Skills-compatible validation, bounded project and global discovery, exact-revision activation, project-first collision handling, and immutable per-Run catalogs.",
		sources: [
			"packages/skills/src/loader.ts",
			"packages/coding-agent/src/skills/manager.ts",
			"packages/coding-agent/src/skills/run-capability.ts",
		],
		tests: [
			"packages/skills/test/loader.test.ts",
			"packages/coding-agent/test/skills-cli.test.ts",
			"packages/coding-agent/test/skills/inventory.test.ts",
		],
	}),
	capability({
		id: "coding-agent.terminal",
		package: "@coda/coding-agent",
		status: "runtime-supported",
		title: "Terminal experience",
		summary:
			"Full-screen semantic Timeline and Transcript View, CommonMark/GFM rendering, Thinking Blocks, a multiline Composer, Prompt History, Slash command, explicit `$` Skill mention, and Workspace-scoped `@` file mention completion, plus background Session activity.",
		sources: [
			"packages/tui/src/tui.ts",
			"packages/coding-agent/src/ui/run-interactive.ts",
			"packages/coding-agent/src/ui/file-mention-composer.ts",
			"packages/coding-agent/src/host/workspace-file-search.ts",
		],
		tests: [
			"packages/tui/test/full-screen-tui.test.ts",
			"packages/coding-agent/test/interactive-mode.test.ts",
			"packages/coding-agent/test/file-mention-composer.test.ts",
			"packages/coding-agent/test/workspace-file-search.test.ts",
		],
	}),
	capability({
		id: "coding-agent.user-shell-and-queues",
		package: "@coda/coding-agent",
		status: "runtime-supported",
		title: "User Shell Adapter and input queues",
		summary:
			"Explicit `!command` User Shell execution remains outside model Context and Session persistence; the CLI Adapter owns its local FIFO and submits Prompt, Steering, and Follow-up input through the public Work Item command seam.",
		sources: [
			"packages/coding-agent/src/ui/user-shell.ts",
			"packages/coding-agent/src/ui/input-controller.ts",
			"packages/coding-agent/src/runtime/session-work-controller.ts",
		],
		tests: [
			"packages/coding-agent/test/user-shell.test.ts",
			"packages/coding-agent/test/interactive-input-controller.test.ts",
		],
	}),
	capability({
		id: "evals.offline-agent",
		package: "@coda/evals",
		status: "runtime-supported",
		title: "Offline Agent evaluation harness",
		summary:
			"Deterministic Faux Model fixtures score observable task behavior, acceptance checks, Tool recovery, repetition, compaction continuity, latency, tokens, and price data without network access.",
		sources: ["packages/evals/src/suite.ts", "packages/evals/src/scoring.ts", "packages/evals/src/trajectory.ts"],
		tests: ["packages/evals/test/evaluation-suite.test.ts"],
	}),
	capability({
		id: "ai.selected-type-closure",
		package: "@coda/ai",
		status: "type-only",
		title: "Selected compatibility type closure",
		summary:
			"Dormant OAuth, deferred-response, ModelsStore, alternate Provider, and other known-Api shapes remain expressible without promising runtime behavior.",
		sources: ["packages/ai/compatibility/manifest.v1.json", "packages/ai/src/index.ts"],
		tests: ["packages/ai/test/root-exports.test.ts", "packages/ai/test/public-types.consumer.ts"],
	}),
	capability({
		id: "coding-agent.application-interface",
		package: "@coda/coding-agent",
		status: "experimental-private",
		title: "Application composition seams",
		summary:
			"The CLI and its source-level composition seams are private, have an empty npm export map, and carry no application SDK compatibility promise.",
		sources: ["packages/coding-agent/package.json", "packages/coding-agent/src/index.ts"],
		tests: ["packages/coding-agent/test/public-contract.test.ts"],
	}),
	capability({
		id: "skills.allowed-tools-metadata",
		package: "@coda/skills",
		status: "experimental-private",
		title: "Experimental Skill metadata",
		summary:
			"The standard parser preserves `allowed-tools`, but Coda deliberately does not interpret it as Tool, filesystem, process, or network authority.",
		sources: ["packages/skills/src/parser.ts", "packages/coding-agent/src/skills/manager.ts"],
		tests: ["packages/skills/test/parser.test.ts"],
	}),
	capability({
		id: "ai.deferred-response-runtime",
		package: "@coda/ai",
		status: "deferred",
		title: "Deferred model responses",
		summary:
			"Fetching or cancelling deferred Provider responses has type-level representation but no supported OpenCode Go runtime implementation.",
		sources: ["packages/ai/src/models.ts", "packages/ai/src/providers/opencode-go.ts"],
		tests: ["packages/ai/test/opencode-go-provider.test.ts"],
	}),
	capability({
		id: "ai.other-provider-runtimes",
		package: "@coda/ai",
		status: "deferred",
		title: "Additional AI runtimes",
		summary:
			"Complete OAuth, image generation, Providers beyond OpenCode Go or explicit custom Providers, and Browser or Bun entries are not implemented.",
		sources: ["packages/ai/compatibility/manifest.v1.json"],
		tests: ["packages/ai/test/root-exports.test.ts", "packages/ai/test/opencode-go-provider.test.ts"],
	}),
	capability({
		id: "coding-agent.remote-interfaces",
		package: "@coda/coding-agent",
		status: "deferred",
		title: "Remote application interfaces",
		summary: "RPC, client/server mode, and a public Coding Agent SDK are not implemented.",
		sources: ["packages/coding-agent/package.json", "packages/coding-agent/src/index.ts"],
		tests: ["packages/coding-agent/test/public-contract.test.ts"],
	}),
	capability({
		id: "editor.advanced-editing",
		package: "@coda/tui",
		status: "deferred",
		title: "Advanced editing",
		summary:
			"Autocomplete, selection, clipboard protocols, redo, durable drafts, and syntax highlighting are not implemented.",
		sources: ["packages/tui/src/editor.ts", "packages/coding-agent/src/ui/command-composer.ts"],
		tests: ["packages/tui/test/editor.test.ts"],
	}),
	capability({
		id: "mcp.non-tool-primitives",
		package: "@coda/mcp",
		status: "deferred",
		title: "Additional MCP primitives",
		summary:
			"Resources, Prompts, Roots, Sampling, Logging, complete OAuth, and legacy HTTP+SSE transport are outside the current MCP Host.",
		sources: ["packages/mcp/src/host.ts", "packages/mcp/src/sdk-connector.ts"],
		tests: ["packages/mcp/test/host.test.ts", "packages/mcp/test/sdk-wire.test.ts"],
	}),
	capability({
		id: "sessions.branching-and-management",
		package: "@coda/coding-agent",
		status: "deferred",
		title: "Advanced Session management",
		summary: "Session branching, rename, archive, and delete operations are not implemented.",
		sources: ["packages/coding-agent/src/commands/core-commands.ts", "packages/coding-agent/src/session/types.ts"],
		tests: [
			"packages/coding-agent/test/command-registry.test.ts",
			"packages/coding-agent/test/public-contract.test.ts",
		],
	}),
	capability({
		id: "skills.remote-distribution",
		package: "@coda/skills",
		status: "deferred",
		title: "Remote Skill distribution",
		summary: "Remote Skill installation and registries are not implemented; discovery is local and caller-rooted.",
		sources: ["packages/skills/src/loader.ts", "packages/coding-agent/src/skills/roots.ts"],
		tests: ["packages/skills/test/loader.test.ts", "packages/coding-agent/test/skills/roots.test.ts"],
	}),
	capability({
		id: "tui.additional-input-and-images",
		package: "@coda/tui",
		status: "deferred",
		title: "Additional terminal input and image protocols",
		summary:
			"General mouse UI, Sixel, iTerm2 graphics, multiplexer image passthrough, and a generic terminal-image protocol are not implemented.",
		sources: ["packages/tui/src/input.ts", "packages/tui/src/terminal-image-surface.ts"],
		tests: ["packages/tui/test/tui-input-focus-overlay.test.ts", "packages/tui/test/terminal-image-surface.test.ts"],
	}),
] satisfies readonly CapabilityContractEntry[]);

function capability<const T extends CapabilityContractEntry>(entry: T): Readonly<T> {
	return Object.freeze({
		...entry,
		sources: Object.freeze([...entry.sources]),
		tests: Object.freeze([...entry.tests]),
	});
}
