import {
	Agent,
	AgentError,
	type AgentTool,
	type PreparedRun,
	type QueueItemId,
	type RunBudget,
	type RunPreparation,
	type RunResult,
	type SessionChange,
	type SessionEvent,
	type ToolExecutionContext,
} from "@coda/agent";
import { ContextWindowController } from "../context-window/context-window.ts";
import { ContextOverflowRecovery } from "../context-window/overflow-recovery.ts";
import { createCodingAgentRetry } from "../retry.ts";
import type { RunCapabilityHost, RunCapabilityLease, RunToolContribution } from "../run-capabilities.ts";
import type {
	Identity,
	RunModelProvider,
	RuntimeTime,
	WorkerSelection,
	WorkSessionReservation,
	WorkspacePlacementReservation,
	WorkspaceTooling,
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
	options: WorkerRuntimeOptions,
): number | undefined {
	if (preparation.deadline !== undefined) return preparation.deadline;
	const maximum = configuration.runLimits?.maxElapsedMs ?? options.runBudget?.limits.maxElapsedMs;
	return maximum === undefined ? undefined : options.time.clock.now() + maximum;
}

export interface WorkerRuntimeOptions {
	readonly time: RuntimeTime;
	readonly identity: Identity;
	readonly modelProvider: RunModelProvider;
	readonly runCapabilities: RunCapabilityHost;
	readonly tooling: WorkspaceTooling;
	readonly runBudget?: RunBudget;
	readonly maxOutputTokens?: number;
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
	readonly options: WorkerRuntimeOptions;
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
		options.tooling.tools({
			graphId: request.graphId,
			itemId: request.itemId,
			sessionId,
			placement: request.placement.placement,
			mode: request.mode,
		}),
		request.signal,
		undefined,
		options.time.clock.now,
	);
	const bindRequest = {
		graphId: request.graphId,
		itemId: request.itemId,
		sessionId,
		placement: request.placement.placement,
	};
	const baseTools: readonly RunToolContribution[] = Object.freeze([
		...contributions,
		...(request.coordinatorTools ?? []).map((tool) => Object.freeze({ tool, effect: "read" as const })),
	]);
	const bindTools = (runContributions: readonly RunToolContribution[]): readonly AgentTool[] =>
		options.tooling
			.bindTools({ ...bindRequest, contributions: runContributions })
			.map((tool) => gatedTool(tool, request.assertProgressAllowed));
	let desired: FrozenConfiguration = Object.freeze({
		desired: request.configuration,
		selection: await awaitPreparation(
			options.modelProvider.resolve(request.configuration, request.signal),
			request.signal,
			undefined,
			options.time.clock.now,
		),
	});
	let activeCapabilities: RunCapabilityLease | undefined;
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
	const recordSessionChange = async (change: SessionChange): Promise<void> => {
		if (fatalFailure) throw new Error(fatalFailure.diagnostic);
		try {
			await request.session.session.record(change);
		} catch (error) {
			latchFailure("session", change.type, error);
			throw error;
		}
	};
	const contextWindow = new ContextWindowController({
		clock: options.time.clock,
		idGenerator: options.identity,
		runtime: () => {
			const capabilities = activeCapabilities;
			if (!capabilities) throw new Error("Context Window requires an active Run capability lease");
			return { model: capabilities.model.model, complete: capabilities.model.complete };
		},
		commit: (checkpoint) => recordSessionChange({ type: "context_compacted", checkpoint }),
		checkpoint: request.session.session.compactionCheckpoint,
		maxOutputTokens: options.maxOutputTokens,
	});
	const overflowRecovery = new ContextOverflowRecovery({
		contextWindow,
		model: () => {
			if (!activeCapabilities) throw new Error("Context Overflow recovery requires an active Run capability lease");
			return activeCapabilities.model.model;
		},
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
	agent = new Agent({
		clock: options.time.clock,
		idGenerator: options.identity,
		...(options.time.scheduler ? { retry: createCodingAgentRetry(options.time.scheduler) } : {}),
		seed: { ...request.session.session.seed, pendingFollowUps: [] },
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
			let capabilities: RunCapabilityLease | undefined;
			try {
				capabilities = await options.runCapabilities.acquire({
					selection: configuration.selection,
					placement: request.placement.placement,
					mode: request.mode,
					baseTools,
					bindTools,
					signal: preparation.signal,
					...(deadline === undefined ? {} : { deadline }),
				});
				await awaitPreparation(
					recordSessionChange({
						type: "prepare_run",
						promptVersion: capabilities.prompt.version,
						promptSha256: capabilities.prompt.sha256,
					}),
					preparation.signal,
					deadline,
					options.time.clock.now,
				);
				observations.publishPreparation({
					type: "preparation_settled",
					preparationId: submission.preparationId,
					outcome: "prepared",
					promptVersion: capabilities.prompt.version,
					promptSha256: capabilities.prompt.sha256,
				});
				activeCapabilities = capabilities;
				let disposeOperation: Promise<void> | undefined;
				const preparedRun: PreparedRun = {
					tools: capabilities.tools,
					systemPrompt: capabilities.prompt.text,
					...(configuration.desired.runLimits
						? { runBudget: { limits: configuration.desired.runLimits } }
						: options.runBudget
							? { runBudget: options.runBudget }
							: {}),
					recoverFailedAttempt: (attempt) => overflowRecovery.recoverFailedAttempt(attempt, agent.state.messages),
					stream: async ({ context, signal }) => {
						const prepared = await overflowRecovery.prepare(context, agent.state.messages, signal);
						request.assertProgressAllowed();
						if (signal.aborted) throw aborted(signal);
						return capabilities!.model.stream(prepared.context, {
							signal,
							maxTokens: prepared.reservedOutputTokens,
						});
					},
					dispose: () => {
						if (disposeOperation) return disposeOperation;
						disposeOperation = capabilities!.dispose().finally(() => {
							if (activeCapabilities === capabilities) activeCapabilities = undefined;
							if (preparation.queueItemId) followUps.delete(preparation.queueItemId);
							observations.publishPreparation({
								type: "prepared_run_disposed",
								preparationId: submission.preparationId,
							});
						});
						return disposeOperation;
					},
				};
				return Object.freeze(preparedRun);
			} catch (error) {
				if (capabilities) {
					try {
						await capabilities.dispose();
					} catch {}
					if (activeCapabilities === capabilities) activeCapabilities = undefined;
				}
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
				await request.session.session.accept(disposition.session as SessionEvent);
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
				latchFailure("work_graph_store", disposition.fact.type, error);
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
				selection: await options.modelProvider.resolve(configuration, request.signal),
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
					await request.session.release();
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
