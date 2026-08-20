import type {
	CodingAgentCommandBatch,
	CodingAgentReceipt,
	DesiredRuntimeConfigurationPatch,
	RunCapabilitySelections,
	WorkResult,
} from "./types.ts";
import { type GraphRecord, type ItemRecord, isTerminal } from "./work-graph-records.ts";

export interface DelegatedWorkItemSpecification {
	readonly itemId: string;
	readonly objective: string;
	readonly executionMode: "read_only" | "write";
	readonly dependencies?: readonly string[];
	readonly configuration?: DesiredRuntimeConfigurationPatch;
	readonly capabilitySelections?: RunCapabilitySelections;
}

export interface WorkGraphDelegationHost {
	submit(batch: CodingAgentCommandBatch): Promise<CodingAgentReceipt>;
	deactivate(graph: GraphRecord, item: ItemRecord): void;
	requestSchedule(): void;
	mergeCapabilitySelections(
		parent: RunCapabilitySelections | undefined,
		child: RunCapabilitySelections | undefined,
	): RunCapabilitySelections | undefined;
}

export class WorkGraphDelegationController {
	readonly #host: WorkGraphDelegationHost;
	readonly #itemTerminalWaiters: Array<() => void> = [];

	constructor(host: WorkGraphDelegationHost) {
		this.#host = host;
	}

	async delegate(
		graph: GraphRecord,
		parent: ItemRecord,
		specifications: readonly DelegatedWorkItemSpecification[],
		signal: AbortSignal,
		parentCapabilitySelections?: RunCapabilitySelections,
	): Promise<readonly WorkResult[]> {
		if (
			parent.executionMode !== "write" ||
			parent.projection.state !== "running" ||
			parent.projection.cancellationRequested
		) {
			throw new Error(`Work Item ${parent.id} cannot delegate in ${parent.projection.state}`);
		}
		if (parent.process.delegationWaiting) throw new Error(`Work Item ${parent.id} is already waiting on delegation`);
		parent.process.delegationWaiting = true;
		this.#host.deactivate(graph, parent);
		try {
			signal.throwIfAborted();
			const childCapabilitySelections = specifications.map((specification) =>
				this.#host.mergeCapabilitySelections(parentCapabilitySelections, specification.capabilitySelections),
			);
			const receipt = await this.#host.submit({
				commands: [
					{
						type: "add_work_items",
						graphId: graph.id,
						items: specifications.map((specification) => ({
							itemId: specification.itemId,
							parentItemId: parent.id,
							objective: specification.objective,
							executionMode: specification.executionMode,
							...(specification.dependencies ? { dependencies: specification.dependencies } : {}),
							...(specification.configuration ? { configuration: specification.configuration } : {}),
						})),
					},
					...specifications.flatMap((specification, index) => {
						const capabilitySelections = childCapabilitySelections[index];
						return capabilitySelections
							? [
									{
										type: "deliver_work_item_input" as const,
										graphId: graph.id,
										itemId: specification.itemId,
										kind: "prompt" as const,
										input: specification.objective,
										capabilitySelections,
									},
								]
							: [];
					}),
				],
			});
			if (receipt.status === "rejected") {
				throw new Error(`Delegation was rejected (${receipt.rejection.code}): ${receipt.rejection.message}`);
			}
			const delegatedIds = receipt.itemIds;
			while (true) {
				signal.throwIfAborted();
				const results = delegatedIds.map((id) => graph.items.get(id)?.projection.result);
				if (results.every((result): result is WorkResult => result !== undefined)) {
					return Object.freeze(results);
				}
				await this.#waitForItemTerminalChange(signal);
			}
		} finally {
			await this.#resumeDelegatingItem(parent, signal);
		}
	}

	noteItemTerminal(): void {
		for (const resolve of this.#itemTerminalWaiters.splice(0)) resolve();
	}

	#waitForItemTerminalChange(signal: AbortSignal): Promise<void> {
		if (signal.aborted) return Promise.reject(signal.reason);
		return new Promise<void>((resolve, reject) => {
			const cleanup = (): void => {
				signal.removeEventListener("abort", onAbort);
				const index = this.#itemTerminalWaiters.indexOf(onTerminal);
				if (index >= 0) this.#itemTerminalWaiters.splice(index, 1);
			};
			const onTerminal = (): void => {
				cleanup();
				resolve();
			};
			const onAbort = (): void => {
				cleanup();
				reject(signal.reason);
			};
			this.#itemTerminalWaiters.push(onTerminal);
			signal.addEventListener("abort", onAbort, { once: true });
		});
	}

	async #resumeDelegatingItem(item: ItemRecord, signal: AbortSignal): Promise<void> {
		if (item.process.active) {
			item.process.delegationWaiting = false;
			return;
		}
		if (item.projection.cancellationRequested || signal.aborted || isTerminal(item.projection.state)) {
			item.process.delegationWaiting = false;
			return;
		}
		await new Promise<void>((resolve, reject) => {
			const onAbort = (): void => {
				if (item.process.delegationResume?.resolve !== onResume) return;
				item.process.delegationResume = undefined;
				item.process.delegationWaiting = false;
				reject(signal.reason);
			};
			const onResume = (): void => {
				signal.removeEventListener("abort", onAbort);
				resolve();
			};
			item.process.delegationResume = {
				resolve: onResume,
				reject: (error) => {
					signal.removeEventListener("abort", onAbort);
					reject(error);
				},
			};
			signal.addEventListener("abort", onAbort, { once: true });
			this.#host.requestSchedule();
		});
	}
}
