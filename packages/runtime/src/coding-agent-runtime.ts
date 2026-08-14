import type {
	AgentEvent,
	AgentInput,
	AgentState,
	AgentTool,
	Clock,
	IdGenerator,
	QueueItemId,
	RunBudget,
	RunResult,
} from "@coda/agent";
import type { Api, AuthResult, Model, Models, ThinkingLevel } from "@coda/ai";
import type { McpElicitationResult, McpToolSnapshot } from "@coda/mcp";
import { ContextWindowController } from "./context-window/context-window.ts";
import { ContextOverflowRecovery } from "./context-window/overflow-recovery.ts";
import type { CompactionCheckpoint } from "./context-window/types.ts";
import { createMcpAgentTools, type McpAgentElicitation } from "./mcp/tools.ts";
import {
	buildSystemPrompt,
	type SystemPromptSnapshot,
	type TrustedProjectInstructions,
} from "./prompt/prompt-builder.ts";
import { createCodingAgentRetry, type RuntimeScheduler } from "./retry.ts";
import { openAgentRuntime } from "./runtime.ts";
import { promptSkillCatalog } from "./skills/catalog.ts";
import { RunSkillsCoordinator } from "./skills/run-coordinator.ts";
import { createSkillTool } from "./skills/tool.ts";
import type { CodingSkillsSnapshot } from "./skills/types.ts";
import type { AgentRuntime, AgentRuntimeEvent, RuntimeCommand, RuntimeCommandResult, RuntimeSession } from "./types.ts";

export interface ModelSelection {
	readonly provider: string;
	readonly id: string;
}

export interface CodingRuntimeSelection {
	readonly model: Model<Api>;
	readonly reasoning: ThinkingLevel | "off";
	readonly authSnapshot?: AuthResult;
}

export interface CodingPreparedRunSnapshot {
	readonly model: Model<Api>;
	readonly reasoning: ThinkingLevel | "off";
	readonly skills: CodingSkillsSnapshot;
	readonly mcp: McpToolSnapshot;
	readonly tools: readonly AgentTool[];
	readonly prompt: SystemPromptSnapshot;
}

export type CodingRuntimeSessionChange =
	| {
			readonly type: "prepare_run";
			readonly promptVersion: string;
			readonly promptSha256: string;
	  }
	| { readonly type: "context_compacted"; readonly checkpoint: CompactionCheckpoint };

/** Durable Session port owned by the Runtime; storage format remains an Adapter concern. */
export interface CodingRuntimeSession extends RuntimeSession {
	readonly compactionCheckpoint?: CompactionCheckpoint;
	record(change: CodingRuntimeSessionChange): Promise<void>;
}

/** Instance-local Skill catalog. A watcher may invalidate it, but each Run receives one frozen snapshot. */
export interface CodingRuntimeSkillsSource {
	readonly initial: CodingSkillsSnapshot;
	current(): CodingSkillsSnapshot | undefined;
	refresh(): Promise<CodingSkillsSnapshot>;
	synchronize?(snapshot: CodingSkillsSnapshot): void;
}

/** Instance-local view over a potentially shared MCP host. */
export interface CodingRuntimeMcpSource {
	current(): McpToolSnapshot;
	refresh?(): Promise<void>;
}

interface InternalDesiredConfiguration extends CodingRuntimeSelection {}

export interface CodingAgentRuntimeSnapshot {
	readonly runtimeId: string;
	readonly sessionId: string;
	readonly closed: boolean;
	readonly desired: Omit<CodingRuntimeSelection, "authSnapshot">;
	readonly activeRun?: {
		readonly runId: string;
		readonly prepared: CodingPreparedRunSnapshot;
	};
	readonly agent: AgentState;
}

export interface CodingRuntimeEventContext {
	readonly runtimeId: string;
	readonly sessionId: string;
	readonly runId: string;
}

/** Complete headless Runtime Interface. The serial Agent kernel remains private. */
export interface CodingAgentRuntime {
	readonly runtimeId: string;
	readonly sessionId: string;
	snapshot(): CodingAgentRuntimeSnapshot;
	select(selection: CodingRuntimeSelection): void;
	selectReasoning(reasoning: ThinkingLevel | "off"): void;
	prompt(input: AgentInput): Promise<RunResult>;
	steer(input: AgentInput): QueueItemId;
	followUp(input: AgentInput): QueueItemId;
	cancel(queueItemId?: QueueItemId): void;
	dispatch(command: RuntimeCommand): Promise<RuntimeCommandResult>;
	waitForIdle(): Promise<void>;
	subscribe(listener: (event: AgentEvent, context: CodingRuntimeEventContext) => Promise<void> | void): () => void;
	requestCompaction(focus?: string): Promise<void>;
	takeUnrecoverableOverflow(): boolean;
	contextUsage(): {
		readonly usedTokens: number;
		readonly windowTokens: number;
		readonly estimated: boolean;
	};
	readonly compactionCost: number | undefined;
	createSkillSnapshotBinding(): string;
	prepareSkillSnapshot(input: AgentInput, snapshot: CodingSkillsSnapshot, binding: string): void;
	close(): Promise<void>;
}

export interface OpenCodingAgentRuntimeOptions {
	readonly runtimeId?: string;
	readonly session: CodingRuntimeSession;
	readonly selection: CodingRuntimeSelection;
	readonly models: Models;
	readonly clock: Clock;
	readonly idGenerator: IdGenerator;
	readonly scheduler?: RuntimeScheduler;
	readonly runBudget?: RunBudget;
	readonly autoDrainFollowUps: boolean;
	readonly interactionMode: "interactive" | "print";
	readonly maxOutputTokens?: number;
	readonly workspaceRoot: string;
	readonly platform: NodeJS.Platform;
	readonly projectInstructions?: TrustedProjectInstructions;
	readonly baseTools: readonly AgentTool[];
	readonly skills: CodingRuntimeSkillsSource;
	readonly mcp: CodingRuntimeMcpSource;
	readonly mcpElicitation?: (request: McpAgentElicitation) => Promise<McpElicitationResult>;
}

export async function openCodingAgentRuntime(options: OpenCodingAgentRuntimeOptions): Promise<CodingAgentRuntime> {
	const baseTools = Object.freeze([...options.baseTools]);
	const toolsForRun = (skills: CodingSkillsSnapshot, mcp: McpToolSnapshot): readonly AgentTool[] => {
		const skillTool = createSkillTool(skills);
		const mcpTools = createMcpAgentTools({
			snapshot: mcp,
			elicit: async (request) => options.mcpElicitation?.(request) ?? { action: "decline" },
		});
		return Object.freeze([...baseTools, ...(skillTool ? [skillTool] : []), ...mcpTools]);
	};
	const runSkills = new RunSkillsCoordinator();
	let internal: AgentRuntime<InternalDesiredConfiguration, CodingPreparedRunSnapshot> | undefined;
	let activeDriver: CodingRuntimeSelection | undefined;
	const currentSelection = (): CodingRuntimeSelection =>
		activeDriver ?? internal?.snapshot().desired ?? options.selection;
	const agentMessages = () => internal?.snapshot().agent.messages ?? options.session.seed?.messages ?? [];
	const contextWindow = new ContextWindowController({
		models: options.models,
		clock: options.clock,
		idGenerator: options.idGenerator,
		runtime: () => {
			const selection = currentSelection();
			return { model: selection.model, authSnapshot: selection.authSnapshot };
		},
		commit: (checkpoint) => options.session.record({ type: "context_compacted", checkpoint }),
		checkpoint: options.session.compactionCheckpoint,
		maxOutputTokens: options.maxOutputTokens,
	});
	const overflowRecovery = new ContextOverflowRecovery({
		contextWindow,
		model: () => currentSelection().model,
		maxOutputTokens: options.maxOutputTokens,
	});
	const freezePrompt = (runtime: Omit<CodingPreparedRunSnapshot, "prompt">): SystemPromptSnapshot =>
		buildSystemPrompt({
			workspace: options.workspaceRoot,
			platform: options.platform,
			timestamp: options.clock.now(),
			tools: runtime.tools.map((tool) => ({ name: tool.name, description: tool.description })),
			capabilities: { interactionMode: options.interactionMode },
			projectInstructions: options.projectInstructions,
			skills: promptSkillCatalog(runtime.skills, runtime.model.contextWindow),
		});

	internal = await openAgentRuntime({
		runtimeId: options.runtimeId ?? `runtime:${options.idGenerator.generate("queue_item")}`,
		session: options.session,
		configuration: options.selection,
		clock: options.clock,
		idGenerator: options.idGenerator,
		...(options.scheduler ? { retry: createCodingAgentRetry(options.scheduler) } : {}),
		...(options.runBudget ? { runBudget: options.runBudget } : {}),
		autoDrainFollowUps: options.autoDrainFollowUps,
		prepareRun: async ({ configuration, inputMessage }) => {
			const skills = runSkills.consume(inputMessage.message.content) ?? (await options.skills.refresh());
			await options.mcp.refresh?.();
			const mcp = options.mcp.current();
			options.skills.synchronize?.(skills);
			const tools = toolsForRun(skills, mcp);
			const withoutPrompt = Object.freeze({
				model: configuration.model,
				reasoning: configuration.reasoning,
				skills,
				mcp,
				tools,
			});
			const prompt = freezePrompt(withoutPrompt);
			await options.session.record({
				type: "prepare_run",
				promptVersion: prompt.version,
				promptSha256: prompt.sha256,
			});
			const driver = Object.freeze({
				model: configuration.model,
				reasoning: configuration.reasoning,
				...(configuration.authSnapshot === undefined ? {} : { authSnapshot: configuration.authSnapshot }),
			});
			activeDriver = driver;
			return {
				snapshot: Object.freeze({ ...withoutPrompt, prompt }),
				tools,
				systemPrompt: prompt.text,
				recoverFailedAttempt: (attempt) => overflowRecovery.recoverFailedAttempt(attempt, agentMessages()),
				stream: async ({ context, signal }) => {
					if (!driver.authSnapshot) {
						throw new Error(`Model is not authenticated: ${driver.model.provider}/${driver.model.id}`);
					}
					const prepared = await overflowRecovery.prepare(context, agentMessages(), signal);
					return options.models.streamSimple(driver.model, prepared.context, {
						signal,
						authSnapshot: driver.authSnapshot,
						reasoning: driver.reasoning === "off" ? undefined : driver.reasoning,
						maxTokens: prepared.reservedOutputTokens,
					});
				},
				dispose: () => {
					if (activeDriver === driver) activeDriver = undefined;
				},
			};
		},
	});

	const core = internal;
	const subscribe = (
		listener: (event: AgentEvent, context: CodingRuntimeEventContext) => Promise<void> | void,
	): (() => void) =>
		core.subscribe((event: AgentRuntimeEvent) =>
			event.type === "agent"
				? listener(
						event.event,
						Object.freeze({
							runtimeId: event.runtimeId,
							sessionId: event.sessionId,
							runId: event.runId,
						}),
					)
				: undefined,
		);
	const facade: CodingAgentRuntime = {
		runtimeId: core.runtimeId,
		sessionId: core.sessionId,
		snapshot: () => {
			const snapshot = core.snapshot();
			return Object.freeze({
				runtimeId: snapshot.runtimeId,
				sessionId: snapshot.sessionId,
				closed: snapshot.closed,
				desired: Object.freeze({ model: snapshot.desired.model, reasoning: snapshot.desired.reasoning }),
				...(snapshot.activeRun
					? {
							activeRun: Object.freeze({
								runId: snapshot.activeRun.runId,
								prepared: snapshot.activeRun.prepared,
							}),
						}
					: {}),
				agent: snapshot.agent,
			});
		},
		select: (selection) => core.updateConfiguration(selection),
		selectReasoning: (reasoning) => {
			const selected = core.snapshot().desired;
			core.updateConfiguration({ ...selected, reasoning });
		},
		prompt: (input) => core.prompt(input),
		steer: (input) => core.steer(input),
		followUp: (input) => core.followUp(input),
		cancel: (queueItemId) => core.cancel(queueItemId),
		dispatch: (command) => core.dispatch(command),
		waitForIdle: () => core.waitForIdle(),
		subscribe,
		requestCompaction: async (focus) => {
			const snapshot = facade.snapshot();
			await contextWindow.requestManual(snapshot.agent.messages, {
				focus,
				defer: snapshot.agent.status === "running",
			});
		},
		takeUnrecoverableOverflow: () => overflowRecovery.takeUnrecoverable(),
		contextUsage: () => {
			const snapshot = facade.snapshot();
			const selected =
				snapshot.activeRun?.prepared ??
				(() => {
					const skills = options.skills.current() ?? options.skills.initial;
					const mcp = options.mcp.current();
					const tools = toolsForRun(skills, mcp);
					const partial = { ...snapshot.desired, skills, mcp, tools };
					return { ...partial, prompt: freezePrompt(partial) };
				})();
			const usage = contextWindow.usage(
				{
					systemPrompt: selected.prompt.text,
					tools: selected.tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
				},
				snapshot.agent.messages,
			);
			return {
				usedTokens: usage.usedTokens,
				windowTokens: selected.model.contextWindow,
				estimated: usage.estimated,
			};
		},
		get compactionCost() {
			return contextWindow.compactionCost;
		},
		createSkillSnapshotBinding: () => runSkills.createBinding(),
		prepareSkillSnapshot: (input, snapshot, binding) => runSkills.prepare(input, snapshot, binding),
		close: () => core.close(),
	};
	core.subscribe(async (event) => {
		if (event.type === "agent" && event.event.type === "run_end") {
			await contextWindow.flushManual(facade.snapshot().agent.messages);
		}
	});
	return facade;
}
