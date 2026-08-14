import {
	Agent,
	AgentError,
	type AgentTool,
	type PreparedRun,
	type QueueItemId,
	type RunPreparation,
	type RunResult,
	type ToolExecutionContext,
} from "@coda/agent";
import type { McpToolSnapshot } from "@coda/mcp";
import { ContextWindowController } from "../context-window/context-window.ts";
import { ContextOverflowRecovery } from "../context-window/overflow-recovery.ts";
import { createMcpAgentTools } from "../mcp/tools.ts";
import { buildSystemPrompt } from "../prompt/prompt-builder.ts";
import { createCodingAgentRetry } from "../retry.ts";
import { promptSkillCatalog } from "../skills/catalog.ts";
import { createSkillTool } from "../skills/tool.ts";
import type { CodingSkillsSnapshot } from "../skills/types.ts";
import type {
	OpenCodingAgentOptions,
	WorkerSelection,
	WorkerSessionChange,
	WorkSessionReservation,
	WorkspacePlacementReservation,
} from "./ports.ts";
import type { DesiredRuntimeConfiguration, WorkExecutionMode, WorkGraphId, WorkItemId } from "./types.ts";
import { routeWorkerEvent } from "./worker-event-router.ts";
import {
	INITIAL_WORKER_FACT_PROJECTION,
	type WorkerFact,
	type WorkerFactProjection,
	workerFactHasOpenEffects,
} from "./worker-fact.ts";
import { WorkerObservationChannel } from "./worker-observation-channel.ts";
import type {
	WorkerBarrierFailure,
	WorkerControlEvent,
	WorkerObservation,
	WorkerSessionEvent,
	WorkerSubmission,
} from "./worker-protocol.ts";

export interface PrivateWorkerRuntime {
	readonly runtimeId: string;
	readonly sessionId: string;
	prompt(submission: WorkerSubmission): Promise<RunResult>;
	steer(submission: WorkerSubmission): void;
	followUp(submission: WorkerSubmission): void;
	cancel(): void;
	waitForIdle(): Promise<void>;
	configure(configuration: DesiredRuntimeConfiguration): Promise<void>;
	assistantText(): string | undefined;
	barrierFailure(): WorkerBarrierFailure | undefined;
	close(): Promise<{ readonly droppedExternalWork: number }>;
}

interface FrozenConfiguration {
	readonly desired: DesiredRuntimeConfiguration;
	readonly selection: WorkerSelection;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function aborted(signal: AbortSignal): unknown {
	return signal.reason ?? new DOMException("Worker preparation was canceled", "AbortError");
}

function gatedTool(tool: AgentTool, assertProgressAllowed: () => void): AgentTool {
	return Object.freeze({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		...(tool.constrainedSampling === undefined ? {} : { constrainedSampling: tool.constrainedSampling }),
		replaySafety: tool.replaySafety,
		...(tool.parallelSafe === undefined ? {} : { parallelSafe: tool.parallelSafe }),
		execute: (arguments_: Parameters<AgentTool["execute"]>[0], context: ToolExecutionContext) => {
			assertProgressAllowed();
			if (context.signal.aborted) throw aborted(context.signal);
			return tool.execute(arguments_, context);
		},
	});
}

async function awaitPreparation<T>(
	operation: T | PromiseLike<T>,
	signal: AbortSignal,
	deadline: number | undefined,
	now: () => number,
): Promise<T> {
	if (signal.aborted) throw aborted(signal);
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (settle: () => void): void => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			if (timer) clearTimeout(timer);
			settle();
		};
		const onAbort = (): void => finish(() => reject(aborted(signal)));
		signal.addEventListener("abort", onAbort, { once: true });
		if (deadline !== undefined) {
			timer = setTimeout(
				() => finish(() => reject(new Error("Worker preparation deadline exceeded"))),
				Math.max(0, deadline - now()),
			);
		}
		Promise.resolve(operation).then(
			(value) => finish(() => resolve(value)),
			(error: unknown) => finish(() => reject(error)),
		);
	});
}

function preparationDeadline(
	preparation: RunPreparation,
	configuration: DesiredRuntimeConfiguration,
	options: OpenCodingAgentOptions,
): number | undefined {
	if (preparation.deadline !== undefined) return preparation.deadline;
	const maximum = configuration.runLimits?.maxElapsedMs ?? options.runBudget?.limits.maxElapsedMs;
	return maximum === undefined ? undefined : options.clock.now() + maximum;
}

function latestAssistantText(agent: Agent): string | undefined {
	for (const entry of [...agent.state.messages].reverse()) {
		if (entry.message.role !== "assistant") continue;
		const text = entry.message.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("");
		if (text.length > 0) return text;
	}
	return undefined;
}

export async function openPrivateWorkerRuntime(request: {
	readonly options: OpenCodingAgentOptions;
	readonly graphId: WorkGraphId;
	readonly itemId: WorkItemId;
	readonly runtimeId: string;
	readonly mode: WorkExecutionMode;
	readonly configuration: DesiredRuntimeConfiguration;
	readonly signal: AbortSignal;
	readonly session: WorkSessionReservation;
	readonly placement: WorkspacePlacementReservation;
	readonly coordinatorTools?: readonly AgentTool[];
	readonly commitFact: (fact: WorkerFact, runtimeId: string, sessionId: string) => Promise<WorkerFactProjection>;
	readonly publishObservation: (observation: WorkerObservation, runtimeId: string, sessionId: string) => void;
	readonly resynchronizeObservations: (runtimeId: string, sessionId: string) => void;
	readonly controlWorker: (event: WorkerControlEvent, runtimeId: string, sessionId: string) => Promise<void> | void;
	readonly barrierFailed: (failure: WorkerBarrierFailure, runtimeId: string, sessionId: string) => void;
	readonly assertProgressAllowed: () => void;
}): Promise<PrivateWorkerRuntime> {
	const { options } = request;
	if (request.signal.aborted) throw aborted(request.signal);
	request.assertProgressAllowed();
	const sessionId = String(request.session.session.id);
	const contributions = await awaitPreparation(
		options.workspaceExecution.tools({
			graphId: request.graphId,
			itemId: request.itemId,
			sessionId,
			placement: request.placement.placement,
			mode: request.mode,
		}),
		request.signal,
		undefined,
		options.clock.now,
	);
	const visibleContributions = contributions.filter(({ effect }) => request.mode === "write" || effect === "read");
	const bindRequest = {
		graphId: request.graphId,
		itemId: request.itemId,
		sessionId,
		placement: request.placement.placement,
	};
	const baseTools = Object.freeze(
		[
			...options.workspaceExecution.bindTools({ ...bindRequest, contributions: visibleContributions }),
			...(request.coordinatorTools ?? []),
		].map((tool) => gatedTool(tool, request.assertProgressAllowed)),
	);
	let desired: FrozenConfiguration = Object.freeze({
		desired: request.configuration,
		selection: await awaitPreparation(
			options.resolveConfiguration(request.configuration),
			request.signal,
			undefined,
			options.clock.now,
		),
	});
	let activeSelection: WorkerSelection | undefined;
	let promptSubmission: WorkerSubmission | undefined;
	const steering = new Map<QueueItemId, WorkerSubmission>();
	const followUps = new Map<QueueItemId, WorkerSubmission>();
	let closeOperation: Promise<{ readonly droppedExternalWork: number }> | undefined;
	let factProjection = INITIAL_WORKER_FACT_PROJECTION;
	let fatalFailure: WorkerBarrierFailure | undefined;
	let agent!: Agent;
	const observations = new WorkerObservationChannel({
		capacity: 256,
		publish: (observation) => request.publishObservation(observation, request.runtimeId, sessionId),
		resynchronize: () => request.resynchronizeObservations(request.runtimeId, sessionId),
	});
	const latchFailure = (
		barrier: WorkerBarrierFailure["barrier"],
		source: WorkerBarrierFailure["source"],
		error: unknown,
	): WorkerBarrierFailure => {
		if (fatalFailure) return fatalFailure;
		fatalFailure = Object.freeze({
			barrier,
			source,
			diagnostic: errorMessage(error),
			openAttempts: Object.freeze(factProjection.openAttempts.map((entry) => Object.freeze({ ...entry }))),
			openTools: Object.freeze(factProjection.openTools.map((entry) => Object.freeze({ ...entry }))),
			externalEffectMayHaveOccurred: workerFactHasOpenEffects(factProjection),
		});
		try {
			request.barrierFailed(fatalFailure, request.runtimeId, sessionId);
		} catch {}
		return fatalFailure;
	};
	const recordSessionChange = async (change: WorkerSessionChange): Promise<void> => {
		if (fatalFailure) throw new Error(fatalFailure.diagnostic);
		try {
			await request.session.session.record(change);
		} catch (error) {
			latchFailure("session", change.type, error);
			throw error;
		}
	};
	const currentSelection = (): WorkerSelection => activeSelection ?? desired.selection;
	const contextWindow = new ContextWindowController({
		models: options.models,
		clock: options.clock,
		idGenerator: options.idGenerator,
		runtime: () => {
			const selection = currentSelection();
			return { model: selection.model, authSnapshot: selection.authSnapshot };
		},
		commit: (checkpoint) => recordSessionChange({ type: "context_compacted", checkpoint }),
		checkpoint: request.session.session.compactionCheckpoint,
		maxOutputTokens: options.maxOutputTokens,
	});
	const overflowRecovery = new ContextOverflowRecovery({
		contextWindow,
		model: () => currentSelection().model,
		maxOutputTokens: options.maxOutputTokens,
	});
	const submissionFor = (preparation: RunPreparation): WorkerSubmission => {
		const submission =
			preparation.source === "prompt"
				? promptSubmission
				: preparation.queueItemId === undefined
					? undefined
					: followUps.get(preparation.queueItemId);
		if (!submission) {
			throw new Error(`Worker Run ${String(preparation.runId)} has no host Submission for ${preparation.source}`);
		}
		if (submission.graphId !== request.graphId || submission.itemId !== request.itemId) {
			throw new Error("Worker Submission causality does not match its owning Work Item");
		}
		return submission;
	};
	const dynamicTools = (skills: CodingSkillsSnapshot, mcp: McpToolSnapshot): readonly AgentTool[] => {
		const skill = createSkillTool(skills);
		const mcpTools = createMcpAgentTools({
			snapshot: mcp,
			elicit: async (elicitation) => options.mcpElicitation?.(elicitation) ?? { action: "decline" },
		});
		const dynamic = [
			...(skill ? [{ tool: skill, effect: "read" as const }] : []),
			...mcpTools.map((tool) => ({ tool, effect: "unknown" as const })),
		].filter(({ effect }) => request.mode === "write" || effect === "read");
		return options.workspaceExecution
			.bindTools({ ...bindRequest, contributions: dynamic })
			.map((tool) => gatedTool(tool, request.assertProgressAllowed));
	};

	agent = new Agent({
		clock: options.clock,
		idGenerator: options.idGenerator,
		...(options.scheduler ? { retry: createCodingAgentRetry(options.scheduler) } : {}),
		...(request.session.session.seed ? { seed: request.session.session.seed } : {}),
		autoDrainFollowUps: true,
		prepareRun: async (preparation): Promise<PreparedRun> => {
			request.assertProgressAllowed();
			const submission = submissionFor(preparation);
			const configuration = desired;
			const deadline = preparationDeadline(preparation, configuration.desired, options);
			observations.publishPreparation({
				type: "preparation_started",
				preparationId: submission.preparationId,
				submissionKind: submission.kind,
				resourceReferences: submission.resourceReferences,
				...(deadline === undefined ? {} : { deadline }),
			});
			try {
				const skills = await awaitPreparation(
					options.skills.refresh(),
					preparation.signal,
					deadline,
					options.clock.now,
				);
				await awaitPreparation(options.mcp.refresh?.(), preparation.signal, deadline, options.clock.now);
				const mcp = options.mcp.current();
				options.skills.synchronize?.(skills);
				const tools = Object.freeze([...baseTools, ...dynamicTools(skills, mcp)]);
				const projectInstructions = await awaitPreparation(
					options.projectInstructions?.(request.placement.placement),
					preparation.signal,
					deadline,
					options.clock.now,
				);
				const prompt = Object.freeze(
					options.systemPrompt ??
						buildSystemPrompt({
							workspace: request.placement.placement.root,
							platform: options.platform,
							timestamp: options.clock.now(),
							tools: tools.map((tool) => ({ name: tool.name, description: tool.description })),
							capabilities: {
								interactionMode: options.interactionMode === "interactive" ? "interactive" : "print",
							},
							...(projectInstructions === undefined ? {} : { projectInstructions }),
							skills: promptSkillCatalog(skills, configuration.selection.model.contextWindow),
						}),
				);
				await awaitPreparation(
					recordSessionChange({
						type: "prepare_run",
						promptVersion: prompt.version,
						promptSha256: prompt.sha256,
					}),
					preparation.signal,
					deadline,
					options.clock.now,
				);
				observations.publishPreparation({
					type: "preparation_settled",
					preparationId: submission.preparationId,
					outcome: "prepared",
				});
				const selection = configuration.selection;
				activeSelection = selection;
				let disposed = false;
				const preparedRun: PreparedRun = {
					tools,
					systemPrompt: prompt.text,
					...(configuration.desired.runLimits
						? { runBudget: { limits: configuration.desired.runLimits } }
						: options.runBudget
							? { runBudget: options.runBudget }
							: {}),
					recoverFailedAttempt: (attempt) => overflowRecovery.recoverFailedAttempt(attempt, agent.state.messages),
					stream: async ({ context, signal }) => {
						if (!selection.authSnapshot) {
							throw new Error(`Model is not authenticated: ${selection.model.provider}/${selection.model.id}`);
						}
						const prepared = await overflowRecovery.prepare(context, agent.state.messages, signal);
						request.assertProgressAllowed();
						if (signal.aborted) throw aborted(signal);
						return options.models.streamSimple(selection.model, prepared.context, {
							signal,
							authSnapshot: selection.authSnapshot,
							reasoning: selection.reasoning === "off" ? undefined : selection.reasoning,
							maxTokens: prepared.reservedOutputTokens,
						});
					},
					dispose: () => {
						if (disposed) return;
						disposed = true;
						if (activeSelection === selection) activeSelection = undefined;
						if (preparation.queueItemId) followUps.delete(preparation.queueItemId);
						observations.publishPreparation({
							type: "prepared_run_disposed",
							preparationId: submission.preparationId,
						});
					},
				};
				return Object.freeze(preparedRun);
			} catch (error) {
				observations.publishPreparation({
					type: "preparation_settled",
					preparationId: submission.preparationId,
					outcome: preparation.signal.aborted ? "canceled" : "failed",
					diagnostic: errorMessage(error),
				});
				throw error;
			}
		},
	});

	const detachAgentObservations = agent.subscribeObservations(
		{
			accept: (event) => observations.publishTransient(routeWorkerEvent(event).observation),
			resynchronize: ({ runId, sequence }) => observations.resynchronizeAgent(String(runId), sequence),
		},
		{ capacity: 256 },
	);

	const handleSemanticEvent = async (disposition: ReturnType<typeof routeWorkerEvent>): Promise<void> => {
		const { observation } = disposition;
		if (fatalFailure) {
			observations.publishSemantic(observation);
			return;
		}
		if (disposition.session) {
			try {
				await request.session.session.accept(disposition.session as WorkerSessionEvent);
			} catch (error) {
				observations.skipAgent(String(observation.runId), observation.sequence);
				latchFailure("session", disposition.session.type, error);
				throw error;
			}
		}
		if (disposition.fact) {
			try {
				factProjection = await request.commitFact(disposition.fact, request.runtimeId, sessionId);
			} catch (error) {
				observations.skipAgent(String(observation.runId), observation.sequence);
				latchFailure("work_journal", disposition.fact.type, error);
				throw error;
			}
		}
		observations.publishSemantic(observation);
		if (disposition.control) {
			try {
				await request.controlWorker(disposition.control, request.runtimeId, sessionId);
			} catch {}
		}
		request.assertProgressAllowed();
	};

	agent.onSemanticEvent((event) => {
		if (event.type === "turn_start") steering.clear();
		const disposition = routeWorkerEvent(event);
		return handleSemanticEvent(disposition);
	});

	return Object.freeze({
		runtimeId: request.runtimeId,
		sessionId,
		prompt: (submission: WorkerSubmission) => {
			if (promptSubmission) return Promise.reject(new Error("Worker already owns an active Prompt Submission"));
			request.assertProgressAllowed();
			promptSubmission = submission;
			let operation: Promise<RunResult>;
			try {
				operation = agent.prompt(submission.input);
			} catch (error) {
				promptSubmission = undefined;
				throw error;
			}
			return operation.finally(() => {
				if (promptSubmission === submission) promptSubmission = undefined;
			});
		},
		steer: (submission: WorkerSubmission) => {
			request.assertProgressAllowed();
			const id = agent.steer(submission.input);
			steering.set(id, submission);
		},
		followUp: (submission: WorkerSubmission) => {
			request.assertProgressAllowed();
			const id = agent.followUp(submission.input);
			followUps.set(id, submission);
		},
		cancel: () => {
			try {
				agent.abort();
			} catch (error) {
				if (!(error instanceof AgentError && error.code === "invalid_lifecycle")) throw error;
			}
		},
		waitForIdle: () => agent.waitForIdle(),
		configure: async (configuration: DesiredRuntimeConfiguration) => {
			desired = Object.freeze({
				desired: configuration,
				selection: await options.resolveConfiguration(configuration),
			});
		},
		assistantText: () => latestAssistantText(agent),
		barrierFailure: () => fatalFailure,
		close: () => {
			if (closeOperation) return closeOperation;
			closeOperation = (async () => {
				const failures: unknown[] = [];
				try {
					agent.abort();
				} catch (error) {
					if (!(error instanceof AgentError && error.code === "invalid_lifecycle")) failures.push(error);
				}
				try {
					await agent.waitForIdle();
				} catch (error) {
					failures.push(error);
				}
				detachAgentObservations();
				observations.invalidateAndClose();
				const droppedExternalWork = steering.size + followUps.size;
				steering.clear();
				followUps.clear();
				try {
					await request.session.session.close();
				} catch (error) {
					failures.push(error);
				}
				if (failures.length === 1) throw failures[0];
				if (failures.length > 1) throw new AggregateError(failures, "Private Worker Runtime close failed");
				return Object.freeze({ droppedExternalWork });
			})();
			return closeOperation;
		},
	});
}
