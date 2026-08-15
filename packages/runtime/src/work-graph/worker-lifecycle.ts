import type { RunResult, ToolExecutionContext } from "@coda/agent";
import type { JsonValue, TimeRuntime } from "@coda/ai";
import { createDelegateTool, type DelegateChildSpecification } from "./delegate-tool.ts";
import type { DurableGraphStore } from "./durable-graph-store.ts";
import type { ObservationBus, WorkerControlSink, WorkspacePlacement } from "./ports.ts";
import type { SessionLeaseRegistry } from "./session-registry.ts";
import type { WorkResult } from "./types.ts";
import { WORK_GRAPH_FACT_VERSION } from "./work-graph-fact.ts";
import { errorMessage, type GraphRecord, type ItemRecord, isTerminal, jsonValue } from "./work-graph-records.ts";
import type { WorkerFact, WorkerFactProjection } from "./worker-fact.ts";
import type {
	WorkerBarrierFailure,
	WorkerControlEvent,
	WorkerObservation,
	WorkerSubmission,
} from "./worker-protocol.ts";
import { openPrivateWorkerRuntime } from "./worker-runtime.ts";

type PrivateWorkerOpenRequest = Parameters<typeof openPrivateWorkerRuntime>[0];

export type { DelegateChildSpecification };

export interface WorkerLifecycleOpenRequest extends Omit<PrivateWorkerOpenRequest, "options" | "coordinatorTools"> {
	readonly delegate?: (
		specifications: readonly DelegateChildSpecification[],
		context: ToolExecutionContext,
	) => Promise<readonly WorkResult[]>;
}

export interface WorkerProgressionHost {
	delegate(specifications: readonly DelegateChildSpecification[], signal: AbortSignal): Promise<readonly WorkResult[]>;
	promptSubmission(): WorkerSubmission;
	transition(to: "settling"): Promise<boolean>;
	settleItem(): Promise<void>;
	settleAfterPersistenceFailure(): Promise<void>;
	interruptInMemory(error: unknown): Promise<void>;
}

/** Owns the single construction seam for private Worker Runtimes. */
export interface WorkerRuntimePort {
	readonly processActiveConcurrency: number;
	open(request: WorkerLifecycleOpenRequest): ReturnType<typeof openPrivateWorkerRuntime>;
	teardown(item: ItemRecord): Promise<boolean>;
	releaseResources(graph: GraphRecord, item: ItemRecord, preserve: boolean): Promise<void>;
	activate(graph: GraphRecord, item: ItemRecord): void;
	deactivate(graph: GraphRecord, item: ItemRecord): void;
	applyCancellation(
		targets: readonly ItemRecord[],
		host: {
			readonly diagnose: (code: string, message: string, itemId: ItemRecord["id"]) => void;
			readonly finalizeUnstarted: (item: ItemRecord) => Promise<void>;
		},
	): Promise<void>;
	commitFact(
		graph: GraphRecord,
		item: ItemRecord,
		fact: WorkerFact,
		runtimeId: string,
		sessionId: string,
	): Promise<WorkerFactProjection>;
	publishObservation(
		graph: GraphRecord,
		item: ItemRecord,
		observation: WorkerObservation,
		runtimeId: string,
		sessionId: string,
	): void;
	resynchronizeObservations(item: ItemRecord, runtimeId: string, sessionId: string): void;
	barrierFailed(
		graph: GraphRecord,
		item: ItemRecord,
		failure: WorkerBarrierFailure,
		runtimeId: string,
		sessionId: string,
	): void;
	deliverControl(
		graph: GraphRecord,
		item: ItemRecord,
		event: WorkerControlEvent,
		runtimeId: string,
		sessionId: string,
	): Promise<void>;
	runItem(graph: GraphRecord, item: ItemRecord, host: WorkerProgressionHost): Promise<void>;
}

/** Sole runtime implementation of WorkerRuntimePort. */
export class WorkerLifecycle implements WorkerRuntimePort {
	readonly #schedule: () => void;
	readonly #durable?: DurableGraphStore<GraphRecord>;
	readonly #sessionRegistry?: SessionLeaseRegistry;
	readonly #placement?: WorkspacePlacement;
	readonly #time?: TimeRuntime;
	readonly #observations?: ObservationBus;
	readonly #workerControl?: WorkerControlSink;
	readonly #runtimeOptions?: PrivateWorkerOpenRequest["options"];
	#processActiveConcurrency = 0;
	#workerControllerAttached = true;

	constructor(
		options: {
			readonly schedule?: () => void;
			readonly durable?: DurableGraphStore<GraphRecord>;
			readonly sessionRegistry?: SessionLeaseRegistry;
			readonly placement?: WorkspacePlacement;
			readonly time?: TimeRuntime;
			readonly observations?: ObservationBus;
			readonly workerControl?: WorkerControlSink;
			readonly runtimeOptions?: PrivateWorkerOpenRequest["options"];
		} = {},
	) {
		this.#schedule = options.schedule ?? (() => undefined);
		this.#durable = options.durable;
		this.#sessionRegistry = options.sessionRegistry;
		this.#placement = options.placement;
		this.#time = options.time;
		this.#observations = options.observations;
		this.#workerControl = options.workerControl;
		this.#runtimeOptions = options.runtimeOptions;
	}

	get processActiveConcurrency(): number {
		return this.#processActiveConcurrency;
	}

	open(request: WorkerLifecycleOpenRequest): ReturnType<typeof openPrivateWorkerRuntime> {
		if (!this.#runtimeOptions) throw new Error("WorkerLifecycle runtime capabilities are unavailable");
		const { delegate, ...runtime } = request;
		return openPrivateWorkerRuntime({
			...runtime,
			options: this.#runtimeOptions,
			...(delegate
				? {
						coordinatorTools: [
							createDelegateTool({
								execute: delegate,
							}),
						],
					}
				: {}),
		});
	}

	teardown(item: ItemRecord): Promise<boolean> {
		if (item.runtimeTeardown) return item.runtimeTeardown;
		if (!item.runtime && !item.runtimeOpening) return Promise.resolve(true);
		item.runtimeTeardown = (async () => {
			const opening = item.runtimeOpening;
			if (opening) {
				item.controller?.abort(new Error("Worker Runtime opening interrupted by teardown"));
				try {
					item.runtime ??= await opening;
				} catch {}
				if (item.runtimeOpening === opening) item.runtimeOpening = undefined;
			}
			const runtime = item.runtime;
			if (!runtime) return true;
			try {
				const closed = await runtime.close();
				item.droppedInputs += closed.droppedExternalWork;
				return true;
			} catch (error) {
				item.diagnostics.push({
					code: "worker_close_failed",
					message: error instanceof Error ? error.message : String(error),
				});
				return false;
			}
		})();
		return item.runtimeTeardown;
	}

	async releaseResources(graph: GraphRecord, item: ItemRecord, preserve: boolean): Promise<void> {
		const durable = this.#durable;
		const sessionRegistry = this.#sessionRegistry;
		const placement = this.#placement;
		const time = this.#time;
		if (!durable || !sessionRegistry || !placement || !time) {
			throw new Error("WorkerLifecycle resource capabilities are unavailable");
		}
		const runtimeReleased = await this.teardown(item);
		if (item.resourcesReleased) return;
		item.resourcesReleased = true;
		let sessionReleased = runtimeReleased;
		if (!item.runtime && item.session) {
			try {
				await item.session.session.close();
			} catch (error) {
				sessionReleased = false;
				item.diagnostics.push({ code: "session_close_failed", message: errorMessage(error) });
			}
		}
		if (item.placement) {
			try {
				await placement.release({
					graphId: graph.id,
					itemId: item.id,
					placement: item.placement.placement,
					preserve,
				});
			} catch (error) {
				item.diagnostics.push({ code: "placement_release_failed", message: errorMessage(error) });
			}
		}
		if (item.sessionId && !sessionReleased) {
			sessionRegistry.quarantine(item.sessionId);
			return;
		}
		try {
			const durableItem = graph.aggregate.snapshot().graph!.items.find(({ itemId }) => itemId === item.id)!;
			if (durableItem.result) {
				await durable.mutation(graph.id, () =>
					durable.appendFacts(graph, [
						{
							version: WORK_GRAPH_FACT_VERSION,
							type: "ownership_released",
							graphId: graph.id,
							itemId: item.id,
							timestamp: Math.max(time.clock.now(), graph.aggregate.snapshot().lastTimestamp ?? 0),
							preservePlacement: preserve,
						},
					]),
				);
			}
			if (item.sessionId) {
				await durable.releaseSession({ sessionId: item.sessionId, graphId: graph.id, itemId: item.id });
				sessionRegistry.release(item.sessionId);
			}
		} catch (error) {
			item.diagnostics.push({ code: "ownership_release_not_recorded", message: errorMessage(error) });
		}
	}

	activate(graph: GraphRecord, item: ItemRecord): void {
		if (item.active) throw new Error(`Work Item ${item.id} already owns an execution slot`);
		item.active = true;
		graph.activeConcurrency++;
		graph.effectiveConcurrency = Math.max(graph.effectiveConcurrency, graph.activeConcurrency);
		this.#processActiveConcurrency++;
	}

	deactivate(graph: GraphRecord, item: ItemRecord): void {
		if (!item.active) return;
		item.active = false;
		graph.activeConcurrency = Math.max(0, graph.activeConcurrency - 1);
		this.#processActiveConcurrency = Math.max(0, this.#processActiveConcurrency - 1);
		this.#schedule();
	}

	async applyCancellation(
		targets: readonly ItemRecord[],
		host: {
			readonly diagnose: (code: string, message: string, itemId: ItemRecord["id"]) => void;
			readonly finalizeUnstarted: (item: ItemRecord) => Promise<void>;
		},
	): Promise<void> {
		for (const item of targets) {
			if (isTerminal(item.state)) continue;
			item.controller?.abort(new Error("Work cancellation requested"));
			try {
				item.runtime?.cancel();
			} catch (error) {
				host.diagnose("worker_cancel_failed", errorMessage(error), item.id);
			}
		}
		for (const item of targets) {
			if (!isTerminal(item.state) && (item.state === "pending" || item.state === "ready")) {
				await host.finalizeUnstarted(item);
			}
		}
		this.#schedule();
	}

	async commitFact(
		graph: GraphRecord,
		item: ItemRecord,
		fact: WorkerFact,
		runtimeId: string,
		sessionId: string,
	): Promise<WorkerFactProjection> {
		const durable = this.#requireDurable();
		return durable.mutation(graph.id, async () => {
			this.#assertWorkerOwnership(item, runtimeId, sessionId);
			const transitionFrom = fact.type === "run_started" && item.state === "preparing" ? "preparing" : undefined;
			if (fact.type === "run_started" && !transitionFrom && item.state !== "running") {
				throw new Error(`Work Item ${item.id} cannot start a Run in ${item.state}`);
			}
			await durable.appendFacts(graph, [
				{
					version: WORK_GRAPH_FACT_VERSION,
					type: "worker_fact_recorded",
					graphId: graph.id,
					timestamp: fact.timestamp,
					itemId: item.id,
					runtimeId,
					sessionId,
					fact,
				},
			]);
			const aggregateItem = graph.aggregate.snapshot().graph!.items.find(({ itemId }) => itemId === item.id)!;
			if (transitionFrom) {
				this.#publish((sequence) => ({
					type: "item_state_changed",
					sequence,
					graphId: graph.id,
					itemId: item.id,
					from: transitionFrom,
					to: "running",
				}));
			}
			return aggregateItem.worker;
		});
	}

	publishObservation(
		graph: GraphRecord,
		item: ItemRecord,
		observation: WorkerObservation,
		runtimeId: string,
		sessionId: string,
	): void {
		this.#assertWorkerOwnership(item, runtimeId, sessionId);
		let event: JsonValue;
		try {
			event = jsonValue(observation);
		} catch (error) {
			this.#diagnose(
				"worker_observation_dropped",
				`Worker Observation projection failed: ${errorMessage(error).slice(0, 384)}`,
				graph,
				item,
			);
			return;
		}
		this.#publish((sequence) => ({
			type: "work_item_event",
			sequence,
			graphId: graph.id,
			itemId: item.id,
			runtimeId,
			sessionId,
			event,
		}));
	}

	resynchronizeObservations(item: ItemRecord, runtimeId: string, sessionId: string): void {
		this.#assertWorkerOwnership(item, runtimeId, sessionId);
		this.#publish((sequence) => ({ type: "resync_required", sequence, reason: "upstream_overflow" }));
	}

	barrierFailed(
		graph: GraphRecord,
		item: ItemRecord,
		failure: WorkerBarrierFailure,
		runtimeId: string,
		sessionId: string,
	): void {
		this.#assertWorkerOwnership(item, runtimeId, sessionId);
		if (item.barrierFailure) return;
		item.barrierFailure = failure;
		if (failure.externalEffectMayHaveOccurred) item.uncertainExternalEffect = true;
		item.diagnostics.push({
			code: `${failure.barrier}_barrier_failed`,
			message: `${failure.source}: ${failure.diagnostic}`,
		});
		if (failure.barrier === "work_graph_store") {
			this.#requireDurable().latchGraphFailure(graph.id, new Error(failure.diagnostic));
			return;
		}
		this.#diagnose("session_barrier_failed", `${failure.source}: ${failure.diagnostic}`.slice(0, 512), graph, item);
	}

	async deliverControl(
		graph: GraphRecord,
		item: ItemRecord,
		event: WorkerControlEvent,
		runtimeId: string,
		sessionId: string,
	): Promise<void> {
		this.#assertWorkerOwnership(item, runtimeId, sessionId);
		const controller = this.#workerControl;
		if (!controller || !this.#workerControllerAttached) return;
		if (!item.placementDescriptor) throw new Error(`Running Work Item ${item.id} has no Workspace placement`);
		try {
			await controller.accept({
				graphId: graph.id,
				itemId: item.id,
				runtimeId,
				sessionId,
				placement: item.placementDescriptor,
				event,
			});
		} catch (error) {
			this.#workerControllerAttached = false;
			this.#diagnose("worker_controller_detached", errorMessage(error).slice(0, 512), graph, item);
		}
	}

	async runItem(graph: GraphRecord, item: ItemRecord, host: WorkerProgressionHost): Promise<void> {
		const time = this.#time;
		if (!time) throw new Error("WorkerLifecycle Time capability is unavailable");
		item.startedAt = time.clock.now();
		item.controller = new AbortController();
		let runtimeOpening: ReturnType<WorkerRuntimePort["open"]> | undefined;
		try {
			if (!item.session || !item.placement) throw new Error("Accepted Work Item is missing reserved ownership");
			const controller = item.controller;
			runtimeOpening = Promise.resolve().then(() =>
				this.open({
					graphId: graph.id,
					itemId: item.id,
					runtimeId: item.runtimeId,
					mode: item.executionMode,
					configuration: item.desiredConfiguration,
					signal: controller.signal,
					session: item.session!,
					placement: item.placement!,
					...(item.executionMode === "write"
						? { delegate: (specifications, context) => host.delegate(specifications, context.signal) }
						: {}),
					commitFact: (fact, runtimeId, sessionId) => this.commitFact(graph, item, fact, runtimeId, sessionId),
					publishObservation: (observation, runtimeId, sessionId) =>
						this.publishObservation(graph, item, observation, runtimeId, sessionId),
					resynchronizeObservations: (runtimeId, sessionId) =>
						this.resynchronizeObservations(item, runtimeId, sessionId),
					controlWorker: (event, runtimeId, sessionId) =>
						this.deliverControl(graph, item, event, runtimeId, sessionId),
					barrierFailed: (failure, runtimeId, sessionId) =>
						this.barrierFailed(graph, item, failure, runtimeId, sessionId),
					assertProgressAllowed: () => this.#requireDurable().assertProgressAllowed(graph.id),
				}),
			);
			item.runtimeOpening = runtimeOpening;
			const runtime = await runtimeOpening;
			item.runtime = runtime;
			if (item.runtimeOpening === runtimeOpening) item.runtimeOpening = undefined;
			if (item.runtimeTeardown || item.resourcesReleased || item.result || isTerminal(item.state)) {
				await this.teardown(item);
				return;
			}
			if (item.cancellationRequested || item.controller.signal.aborted) {
				item.runtime.cancel();
				item.run = { runId: `canceled:${item.id}` as RunResult["runId"], outcome: "aborted" };
				await host.transition("settling");
				this.deactivate(graph, item);
				await host.settleItem();
				return;
			}
			const run = item.runtime.prompt(item.promptInput ?? host.promptSubmission());
			item.promptInput = undefined;
			for (const pending of item.pendingInputs.splice(0)) {
				if (pending.submission.kind === "steering") item.runtime.steer(pending.submission);
				else item.runtime.followUp(pending.submission);
			}
			item.run = await run;
			await item.runtime.waitForIdle();
			await host.transition("settling");
			this.deactivate(graph, item);
		} catch (error) {
			if (item.runtimeOpening === runtimeOpening) item.runtimeOpening = undefined;
			if (item.runtimeTeardown || item.resourcesReleased || item.result || isTerminal(item.state)) return;
			const runtime = item.runtime;
			const barrierFailure = runtime?.barrierFailure();
			if (barrierFailure && !item.barrierFailure) {
				this.barrierFailed(graph, item, barrierFailure, runtime!.runtimeId, runtime!.sessionId);
			}
			if (!barrierFailure) item.diagnostics.push({ code: "worker_failed", message: errorMessage(error) });
			item.run = {
				runId: `failed:${item.id}` as RunResult["runId"],
				outcome: item.cancellationRequested ? "aborted" : "error",
				...(item.cancellationRequested ? {} : { failure: { kind: "runtime", message: errorMessage(error) } }),
			};
			const durable = this.#requireDurable();
			if (durable.ledgerFailure || durable.hasGraphFailure(graph.id)) {
				this.deactivate(graph, item);
				await host.settleAfterPersistenceFailure();
				return;
			}
			if (!isTerminal(item.state) && item.state !== "settling") {
				try {
					await host.transition("settling");
				} catch (transitionError) {
					item.diagnostics.push({
						code: "settlement_transition_failed",
						message: errorMessage(transitionError),
					});
					await host.interruptInMemory(transitionError);
					return;
				}
			}
		}
		this.deactivate(graph, item);
		await host.settleItem();
	}

	#requireDurable(): DurableGraphStore<GraphRecord> {
		if (!this.#durable) throw new Error("WorkerLifecycle durable capability is unavailable");
		return this.#durable;
	}

	#publish(factory: Parameters<ObservationBus["publish"]>[0]): number {
		if (!this.#observations) throw new Error("WorkerLifecycle ObservationBus is unavailable");
		return this.#observations.publish(factory);
	}

	#diagnose(code: string, message: string, graph: GraphRecord, item: ItemRecord): void {
		this.#publish((sequence) => ({
			type: "diagnostic",
			sequence,
			diagnostic: { code, message },
			graphId: graph.id,
			itemId: item.id,
		}));
	}

	#assertWorkerOwnership(item: ItemRecord, runtimeId: string, sessionId: string): void {
		if (item.runtimeId !== runtimeId || item.sessionId !== sessionId) {
			throw new Error(`Worker ownership changed for Work Item ${item.id}`);
		}
	}
}
