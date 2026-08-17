import { createRunCapabilityHost } from "../run-capabilities.ts";
import { createWorkAdmission } from "./admission-controller.ts";
import { WorkCoordinator } from "./coordinator.ts";
import { DurableGraphStore } from "./durable-graph-store.ts";
import { MemoryWorkspacePersistence } from "./memory-workspace-persistence.ts";
import { ObservationFanOut } from "./observation-fan-out.ts";
import type { OpenCodingAgentOptions } from "./ports.ts";
import { PublicationSequencer } from "./publication-sequencer.ts";
import { WorkGraphRecovery } from "./recovery.ts";
import { SessionLeaseRegistry } from "./session-registry.ts";
import type { CodingAgent } from "./types.ts";
import { WorkGraphEngine } from "./work-graph-engine.ts";
import { type GraphRecord, WorkGraphMirror } from "./work-graph-records.ts";
import { WorkerLifecycle } from "./worker-lifecycle.ts";

/** Runtime composition root for the public Coding Agent contract. */
export async function openCodingAgent(options: OpenCodingAgentOptions): Promise<CodingAgent> {
	const mirror = new WorkGraphMirror(options.capacity);
	const graphs = new Map<GraphRecord["id"], GraphRecord>();
	const graphOrder: GraphRecord[] = [];
	const observations = options.observationBus ?? new ObservationFanOut();
	const sessionRegistry = new SessionLeaseRegistry();
	const runCapabilities = createRunCapabilityHost({
		model: { acquire: (selection, signal) => options.modelProvider.lease(selection, signal) },
		contributors: options.capabilitySources,
		now: options.time.clock.now,
		platform: options.platform,
		interactionMode: options.interactionMode,
		...(options.projectInstructions ? { projectInstructions: options.projectInstructions } : {}),
		...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
	});
	let engine!: WorkGraphEngine;
	const durable = new DurableGraphStore<GraphRecord>(options.persistence ?? new MemoryWorkspacePersistence(), {
		projectGraph: (graph) => mirror.projectGraph(graph),
		onGraphFailStop: (graphId, error) => engine.failStopGraph(graphId, error),
		onLedgerFailStop: (error) => engine.failStopLedger(error),
		diagnose: (code, message, graphId) => engine.reportPersistenceDiagnostic(code, message, graphId),
	});
	const workerLifecycle = new WorkerLifecycle({
		schedule: () => engine.schedule(),
		durable,
		sessionRegistry,
		placement: options.placement,
		time: options.time,
		observations,
		...(options.workerControl ? { workerControl: options.workerControl } : {}),
		runtimeOptions: {
			time: options.time,
			identity: options.identity,
			modelProvider: options.modelProvider,
			runCapabilities,
			tooling: options.tooling,
			...(options.runBudget ? { runBudget: options.runBudget } : {}),
			...(options.maxOutputTokens === undefined ? {} : { maxOutputTokens: options.maxOutputTokens }),
			...(options.lifecycleHooks ? { lifecycleHooks: options.lifecycleHooks } : {}),
		},
	});
	engine = new WorkGraphEngine(
		{
			time: options.time,
			identity: options.identity,
			modelProvider: options.modelProvider,
			runCapabilities,
			placement: options.placement,
			tooling: options.tooling,
			sessions: options.sessions,
			...(options.resources ? { resources: options.resources } : {}),
			capacity: options.capacity,
			admission: options.admission ?? createWorkAdmission(options.capacity),
			...(options.runBudget ? { runBudget: options.runBudget } : {}),
			...(options.maxOutputTokens === undefined ? {} : { maxOutputTokens: options.maxOutputTokens }),
			...(options.workerControl ? { workerControl: options.workerControl } : {}),
		},
		{
			graphs,
			graphOrder,
			observations,
			sessionRegistry,
			mirror,
			workerLifecycle,
			publicationSequencer: new PublicationSequencer({
				durable,
				publication: options.publication,
				time: options.time,
			}),
			durable,
		},
	);
	await new WorkGraphRecovery({
		time: options.time,
		placement: options.placement,
		sessions: options.sessions,
		durable,
		sessionRegistry,
		observations,
		mirror,
		graphs,
		graphOrder,
		progression: engine,
	}).initialize();
	return Object.freeze(new WorkCoordinator(engine));
}
