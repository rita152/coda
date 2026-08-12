import { CORE_COMMANDS } from "../commands/core-commands.ts";
import { AUTH_API_PROTOCOLS } from "../providers/types.ts";
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
		id: "ai.model-access",
		package: "@coda/ai",
		status: "runtime-supported",
		title: "Model access",
		summary:
			"OpenCode Go and custom API-key Providers, streaming text, Thinking, Tool calls, structured Diagnostics, cancellation, and explicit model-catalog refresh.",
		sources: ["packages/ai/src/providers/opencode-go.ts", "packages/coding-agent/src/providers/provider-manager.ts"],
		tests: ["packages/ai/test/opencode-go-provider.test.ts", "packages/coding-agent/test/provider-manager.test.ts"],
	}),
	capability({
		id: "coding-agent.built-in-tools",
		package: "@coda/coding-agent",
		status: "runtime-supported",
		title: "Built-in Tools",
		summary:
			"Workspace-aware reading, search, mutation, Shell execution, and recoverable continuation of omitted Tool output.",
		sources: ["packages/coding-agent/src/tools/index.ts"],
		tests: [
			"packages/coding-agent/test/read-tool.test.ts",
			"packages/coding-agent/test/search-tools.test.ts",
			"packages/coding-agent/test/mutation-tools.test.ts",
			"packages/coding-agent/test/bash-tool.test.ts",
		],
	}),
	capability({
		id: "coding-agent.context-compaction",
		package: "@coda/coding-agent",
		status: "runtime-supported",
		title: "Durable Context Compaction",
		summary:
			"Auto-Compaction and `/compact [focus]` share one Tool-pair-safe implementation and persist Compaction Checkpoints before replacing the model-visible Context Window.",
		sources: [
			"packages/coding-agent/src/context-window/context-window.ts",
			"packages/coding-agent/src/commands/core-commands.ts",
			"packages/coding-agent/src/session/records.ts",
		],
		tests: [
			"packages/coding-agent/test/compaction.test.ts",
			"packages/coding-agent/test/context-overflow.test.ts",
			"packages/coding-agent/test/context-window.test.ts",
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
		sources: ["packages/mcp/src/host.ts", "packages/coding-agent/src/mcp/registry.ts"],
		tests: ["packages/mcp/test/host.test.ts", "packages/coding-agent/test/mcp/application.test.ts"],
	}),
	capability({
		id: "coding-agent.permissions",
		package: "@coda/coding-agent",
		status: "runtime-supported",
		title: "Permissions and Sandbox",
		summary:
			"Read Only, Workspace, and Full Access Permission Profiles; four Approval Policies; exact grants and rules; and OS-enforced macOS or Linux Sandbox execution.",
		sources: ["packages/coding-agent/src/permissions/permission-engine.ts", "packages/sandbox/src/execute.ts"],
		tests: ["packages/coding-agent/test/permission-engine.test.ts", "packages/sandbox/test/execute.test.ts"],
	}),
	capability({
		id: "coding-agent.prompt-events",
		package: "@coda/coding-agent",
		status: "runtime-supported",
		title: "Prompt and event formats",
		summary:
			"Deterministic per-Run System Prompt snapshots and stable opt-in JSONL v2 Agent events with optional media data.",
		sources: ["packages/coding-agent/src/prompt/prompt-builder.ts", "packages/coding-agent/src/application.ts"],
		tests: [
			"packages/coding-agent/test/prompt-builder.test.ts",
			"packages/coding-agent/test/application-print.test.ts",
		],
	}),
	capability({
		id: "coding-agent.sessions",
		package: "@coda/coding-agent",
		status: "runtime-supported",
		title: "Durable Sessions",
		summary:
			"Append-only workspace-scoped Sessions restore Messages, queues, Composer and Extension facts, Media Assets, Model and Permission selection, Tool Observations, and Compaction Checkpoints.",
		sources: [
			"packages/coding-agent/src/session/records.ts",
			"packages/coding-agent/src/session/file-session-manager.ts",
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
		sources: ["packages/skills/src/loader.ts", "packages/coding-agent/src/skills/manager.ts"],
		tests: ["packages/skills/test/loader.test.ts", "packages/coding-agent/test/skills-cli.test.ts"],
	}),
	capability({
		id: "coding-agent.terminal",
		package: "@coda/tui",
		status: "runtime-supported",
		title: "Terminal experience",
		summary:
			"Full-screen semantic Timeline and Transcript View, CommonMark/GFM rendering, Thinking Blocks, a multiline Composer, Prompt History, Slash completion, and background Session activity.",
		sources: ["packages/tui/src/tui.ts", "packages/coding-agent/src/interactive/run-interactive.ts"],
		tests: ["packages/tui/test/full-screen-tui.test.ts", "packages/coding-agent/test/interactive-mode.test.ts"],
	}),
	capability({
		id: "coding-agent.user-shell-and-queues",
		package: "@coda/coding-agent",
		status: "runtime-supported",
		title: "User Shell and input queues",
		summary:
			"Explicit `!command` User Shell execution remains outside model Context and Session persistence; the Input Queue Controller orders Steering, durable Follow-ups, and User Shell work in one deferred FIFO.",
		sources: [
			"packages/coding-agent/src/interactive/user-shell.ts",
			"packages/coding-agent/src/interactive/input-controller.ts",
		],
		tests: [
			"packages/coding-agent/test/user-shell.test.ts",
			"packages/coding-agent/test/interactive-input-controller.test.ts",
		],
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
		sources: ["packages/tui/src/editor.ts", "packages/coding-agent/src/interactive/command-composer.ts"],
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
