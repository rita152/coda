import type { RunResult, ToolExecutionContext } from "@coda/agent";
import { createDelegateTool, type DelegateChildSpecification } from "./delegate-tool.ts";
import type { DurableGraphStore } from "./durable-graph-store.ts";
import type { ObservationBus, RuntimeTime, WorkerControlSink, WorkspacePlacement } from "./ports.ts";
import type { SessionLeaseRegistry } from "./session-registry.ts";
import type { WorkResult } from "./types.ts";
import { WORK_GRAPH_FACT_VERSION } from "./work-graph-fact.ts";
import { errorMessage, type GraphRecord, type ItemRecord, isTerminal } from "./work-graph-records.ts";
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
	readonly #time?: RuntimeTime;
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
			readonly time?: RuntimeTime;
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
		if (item.process.runtimeTeardown) return item.process.runtimeTeardown;
		if (!item.process.runtime && !item.process.runtimeOpening) return Promise.resolve(true);
		item.process.runtimeTeardown = (async () => {
			const opening = item.process.runtimeOpening;
			if (opening) {
				item.process.controller?.abort(new Error("Worker Runtime opening interrupted by teardown"));
				try {
					item.process.runtime ??= await opening;
				} catch {}
				if (item.process.runtimeOpening === opening) item.process.runtimeOpening = undefined;
			}
			const runtime = item.process.runtime;
			if (!runtime) return true;
			try {
				const closed = await runtime.close();
				item.process.droppedInputs += closed.droppedExternalWork;
				return true;
			} catch (error) {
				item.process.diagnostics.push({
					code: "worker_close_failed",
					message: error instanceof Error ? error.message : String(error),
				});
				return false;
			}
		})();
		return item.process.runtimeTeardown;
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
		if (item.process.resourcesReleased) return;
		item.process.resourcesReleased = true;
		let sessionReleased = runtimeReleased;
		if (!item.process.runtime && item.process.session) {
			try {
				await item.process.session.release();
			} catch (error) {
				sessionReleased = false;
				item.process.diagnostics.push({ code: "session_close_failed", message: errorMessage(error) });
			}
		}
		if (item.process.placement) {
			try {
				await placement.release({
					graphId: graph.id,
					itemId: item.id,
					placement: item.process.placement.placement,
					preserve,
				});
			} catch (error) {
				item.process.diagnostics.push({ code: "placement_release_failed", message: errorMessage(error) });
			}
		}
		if (item.projection.sessionId && !sessionReleased) {
			sessionRegistry.quarantine(item.projection.sessionId);
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
			if (item.projection.sessionId) {
				await durable.releaseSession({ sessionId: item.projection.sessionId, graphId: graph.id, itemId: item.id });
				sessionRegistry.release(item.projection.sessionId);
			}
		} catch (error) {
			item.process.diagnostics.push({ code: "ownership_release_not_recorded", message: errorMessage(error) });
		}
	}

	activate(graph: GraphRecord, item: ItemRecord): void {
		if (item.process.active) throw new Error(`Work Item ${item.id} already owns an execution slot`);
		item.process.active = true;
		graph.activeConcurrency++;
		graph.effectiveConcurrency = Math.max(graph.effectiveConcurrency, graph.activeConcurrency);
		this.#processActiveConcurrency++;
	}

	deactivate(graph: GraphRecord, item: ItemRecord): void {
		if (!item.process.active) return;
		item.process.active = false;
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
			if (isTerminal(item.projection.state)) continue;
			item.process.controller?.abort(new Error("Work cancellation requested"));
			try {
				item.process.runtime?.cancel();
			} catch (error) {
				host.diagnose("worker_cancel_failed", errorMessage(error), item.id);
			}
		}
		for (const item of targets) {
			if (
				!isTerminal(item.projection.state) &&
				(item.projection.state === "pending" || item.projection.state === "ready")
			) {
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
			const transitionFrom =
				fact.type === "run_started" && item.projection.state === "preparing" ? "preparing" : undefined;
			if (fact.type === "run_started" && !transitionFrom && item.projection.state !== "running") {
				throw new Error(`Work Item ${item.id} cannot start a Run in ${item.projection.state}`);
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
		this.#publish((sequence) => ({
			type: "work_item_event",
			sequence,
			graphId: graph.id,
			itemId: item.id,
			runtimeId,
			sessionId,
			event: observation,
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
		if (item.process.barrierFailure) return;
		item.process.barrierFailure = failure;
		if (failure.externalEffectMayHaveOccurred) item.process.uncertainExternalEffect = true;
		item.process.diagnostics.push({
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
		if (!item.projection.placementDescriptor)
			throw new Error(`Running Work Item ${item.id} has no Workspace placement`);
		try {
			await controller.accept({
				graphId: graph.id,
				itemId: item.id,
				runtimeId,
				sessionId,
				placement: item.projection.placementDescriptor,
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
		item.process.controller = new AbortController();
		let runtimeOpening: ReturnType<WorkerRuntimePort["open"]> | undefined;
		try {
			if (!item.process.session || !item.process.placement)
				throw new Error("Accepted Work Item is missing reserved ownership");
			const controller = item.process.controller;
			runtimeOpening = Promise.resolve().then(() =>
				this.open({
					graphId: graph.id,
					itemId: item.id,
					runtimeId: item.runtimeId,
					mode: item.executionMode,
					configuration: item.projection.desiredConfiguration,
					signal: controller.signal,
					session: item.process.session!,
					placement: item.process.placement!,
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
			item.process.runtimeOpening = runtimeOpening;
			const runtime = await runtimeOpening;
			item.process.runtime = runtime;
			if (item.process.runtimeOpening === runtimeOpening) item.process.runtimeOpening = undefined;
			if (
				item.process.runtimeTeardown ||
				item.process.resourcesReleased ||
				item.projection.result ||
				isTerminal(item.projection.state)
			) {
				await this.teardown(item);
				return;
			}
			if (item.projection.cancellationRequested || item.process.controller.signal.aborted) {
				item.process.runtime.cancel();
				item.process.run = { runId: `canceled:${item.id}` as RunResult["runId"], outcome: "aborted" };
				await host.transition("settling");
				this.deactivate(graph, item);
				await host.settleItem();
				return;
			}
			const run = item.process.runtime.prompt(item.process.promptInput ?? host.promptSubmission());
			item.process.promptInput = undefined;
			for (const pending of item.process.pendingInputs.splice(0)) {
				if (pending.submission.kind === "steering") item.process.runtime.steer(pending.submission);
				else item.process.runtime.followUp(pending.submission);
			}
			item.process.run = await run;
			await item.process.runtime.waitForIdle();
			await host.transition("settling");
			this.deactivate(graph, item);
		} catch (error) {
			if (item.process.runtimeOpening === runtimeOpening) item.process.runtimeOpening = undefined;
			if (
				item.process.runtimeTeardown ||
				item.process.resourcesReleased ||
				item.projection.result ||
				isTerminal(item.projection.state)
			) {
				return;
			}
			const runtime = item.process.runtime;
			const barrierFailure = runtime?.barrierFailure();
			if (barrierFailure && !item.process.barrierFailure) {
				this.barrierFailed(graph, item, barrierFailure, runtime!.runtimeId, runtime!.sessionId);
			}
			if (!barrierFailure) item.process.diagnostics.push({ code: "worker_failed", message: errorMessage(error) });
			item.process.run = {
				runId: `failed:${item.id}` as RunResult["runId"],
				outcome: item.projection.cancellationRequested ? "aborted" : "error",
				...(item.projection.cancellationRequested
					? {}
					: { failure: { kind: "runtime", message: errorMessage(error) } }),
			};
			const durable = this.#requireDurable();
			if (durable.ledgerFailure || durable.hasGraphFailure(graph.id)) {
				this.deactivate(graph, item);
				await host.settleAfterPersistenceFailure();
				return;
			}
			if (!isTerminal(item.projection.state) && item.projection.state !== "settling") {
				try {
					await host.transition("settling");
				} catch (transitionError) {
					item.process.diagnostics.push({
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
		if (item.runtimeId !== runtimeId || item.projection.sessionId !== sessionId) {
			throw new Error(`Worker ownership changed for Work Item ${item.id}`);
		}
	}
}
