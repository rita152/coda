import type { TimeRuntime } from "@coda/ai";
import type { DurableGraphStore } from "./durable-graph-store.ts";
import type { WorkspacePublication } from "./ports.ts";
import type {
	PublicationOutcome,
	WorkDiagnostic,
	WorkResult,
	WorkspaceArtifact,
	WorkspacePlacementDescriptor,
} from "./types.ts";
import { WORK_GRAPH_FACT_VERSION } from "./work-graph-fact.ts";
import type { GraphRecord, ItemRecord } from "./work-graph-records.ts";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export interface PublicationSettlement {
	readonly terminal: WorkResult["state"];
	readonly publication: PublicationOutcome;
	readonly diagnostics: readonly WorkDiagnostic[];
}

/** Owns the durable started -> external publish -> settled protocol and target identity recording. */
export class PublicationSequencer {
	readonly #durable: DurableGraphStore<GraphRecord>;
	readonly #publication: WorkspacePublication;
	readonly #time: TimeRuntime;

	constructor(options: {
		readonly durable: DurableGraphStore<GraphRecord>;
		readonly publication: WorkspacePublication;
		readonly time: TimeRuntime;
	}) {
		this.#durable = options.durable;
		this.#publication = options.publication;
		this.#time = options.time;
	}

	async publish(request: {
		readonly graph: GraphRecord;
		readonly item: ItemRecord;
		readonly artifact: WorkspaceArtifact;
		readonly placement: WorkspacePlacementDescriptor;
		readonly target?: WorkspacePlacementDescriptor;
		readonly signal: AbortSignal;
		readonly terminal: WorkResult["state"];
	}): Promise<PublicationSettlement> {
		const { graph, item, artifact } = request;
		let terminal = request.terminal;
		let publication: PublicationOutcome = item.cancellationRequested
			? { state: "not_published", reason: "canceled" }
			: terminal !== "succeeded"
				? { state: "not_published", reason: terminal === "interrupted" ? "interrupted" : "failed" }
				: { state: "not_required" };
		const diagnostics: WorkDiagnostic[] = [];
		let started = false;
		if (!item.cancellationRequested && terminal === "succeeded") {
			try {
				started = await this.#durable.mutation(graph.id, async () => {
					if (item.cancellationRequested || graph.cancellationRequested) return false;
					await this.#durable.appendFacts(graph, [
						{
							version: WORK_GRAPH_FACT_VERSION,
							type: "publication_started",
							graphId: graph.id,
							itemId: item.id,
							timestamp: Math.max(this.#time.clock.now(), graph.aggregate.snapshot().lastTimestamp ?? 0),
							artifact,
							...(request.target ? { target: request.target } : {}),
						},
					]);
					return true;
				});
			} catch (error) {
				terminal = "failed";
				publication = { state: "not_published", reason: "failed", diagnostic: errorMessage(error) };
				diagnostics.push({ code: "publication_start_barrier_failed", message: errorMessage(error) });
			}
		}
		if (!started && (item.cancellationRequested || graph.cancellationRequested)) {
			terminal = "canceled";
			publication = { state: "not_published", reason: "canceled" };
		}
		if (started) {
			try {
				publication = await this.#publication.publish({
					graphId: graph.id,
					itemId: item.id,
					artifact,
					placement: request.placement,
					...(request.target ? { target: request.target } : {}),
					signal: request.signal,
				});
			} catch (error) {
				terminal = "interrupted";
				publication = { state: "not_published", reason: "interrupted", diagnostic: errorMessage(error) };
				diagnostics.push({ code: "publication_interrupted", message: errorMessage(error) });
			}
		}
		try {
			await this.#durable.mutation(graph.id, () =>
				this.#durable.appendFacts(graph, [
					{
						version: WORK_GRAPH_FACT_VERSION,
						type: "publication_settled",
						graphId: graph.id,
						itemId: item.id,
						timestamp: Math.max(this.#time.clock.now(), graph.aggregate.snapshot().lastTimestamp ?? 0),
						artifact,
						publication,
					},
				]),
			);
			if (
				(publication.state === "published" || publication.state === "not_required") &&
				publication.targetPlacementId &&
				publication.targetIdentity
			) {
				await this.#durable.recordTargetIdentity(publication.targetPlacementId, publication.targetIdentity);
			}
		} catch (error) {
			terminal = "interrupted";
			publication = { state: "not_published", reason: "interrupted", diagnostic: errorMessage(error) };
			diagnostics.push({ code: "publication_barrier_failed", message: errorMessage(error) });
		}
		return Object.freeze({ terminal, publication, diagnostics: Object.freeze(diagnostics) });
	}
}
