import { type AgentEvent, BoundedObservationQueue } from "@coda/agent";
import type { WorkPreparationObservation } from "./types.ts";
import type { WorkerObservation } from "./worker-protocol.ts";

type PendingAgentObservation = AgentEvent | null;

type Delivery =
	| { readonly type: "observation"; readonly observation: WorkerObservation }
	| { readonly type: "resynchronize" };

export interface WorkerObservationChannelOptions {
	readonly capacity: number;
	readonly publish: (observation: WorkerObservation) => void;
	readonly resynchronize: () => void;
}

/**
 * The process-local, lossy handoff between one Worker and the Coordinator.
 *
 * Agent sequence gaps are held only up to `capacity`. Delivery is always moved
 * to a later microtask, so projection and subscriber fan-out can never execute
 * on the Agent, Model, Tool, Session, or Worker-Fact barrier stack.
 */
export class WorkerObservationChannel {
	readonly #capacity: number;
	readonly #publish: WorkerObservationChannelOptions["publish"];
	readonly #resynchronize: WorkerObservationChannelOptions["resynchronize"];
	readonly #pending = new Map<number, PendingAgentObservation>();
	readonly #deliveries: BoundedObservationQueue<Delivery>;
	#runId?: string;
	#nextSequence = 1;
	#highestSequence = 0;
	#closed = false;

	constructor(options: WorkerObservationChannelOptions) {
		this.#capacity = options.capacity;
		this.#publish = options.publish;
		this.#resynchronize = options.resynchronize;
		this.#deliveries = new BoundedObservationQueue({
			capacity: options.capacity,
			capacityName: "Worker Observation",
			yieldBetweenDeliveries: true,
			deliver: (delivery) => {
				try {
					if (delivery.type === "resynchronize") this.#resynchronize();
					else this.#publish(delivery.observation);
				} catch {}
			},
		});
	}

	publishSemantic(event: AgentEvent): void {
		if (this.#closed) return;
		const runId = String(event.runId);
		if (event.type === "run_start") this.#beginRun(runId);
		else if (this.#runId !== runId) {
			this.#requireResynchronization();
			return;
		}
		this.#publishCurrent(event);
	}

	publishTransient(event: AgentEvent): void {
		if (this.#closed) return;
		if (this.#runId !== String(event.runId)) {
			this.#requireResynchronization();
			return;
		}
		this.#publishCurrent(event);
	}

	#publishCurrent(event: AgentEvent): void {
		const sequence = event.sequence;
		if (!Number.isSafeInteger(sequence) || this.#pending.has(sequence)) return;
		if (sequence < this.#nextSequence) {
			this.#requireResynchronization();
			return;
		}
		this.#highestSequence = Math.max(this.#highestSequence, sequence);
		if (this.#pending.size >= this.#capacity) {
			this.#overflowAgentOrder();
			return;
		}
		this.#pending.set(sequence, event);
		this.#promoteContiguous();
	}

	skipAgent(runId: string, sequence: number): void {
		if (this.#closed) return;
		if (this.#runId !== runId) this.#beginRun(runId);
		if (!Number.isSafeInteger(sequence) || sequence < this.#nextSequence || this.#pending.has(sequence)) return;
		this.#highestSequence = Math.max(this.#highestSequence, sequence);
		if (this.#pending.size >= this.#capacity) {
			this.#overflowAgentOrder();
			return;
		}
		this.#pending.set(sequence, null);
		this.#promoteContiguous();
	}

	publishPreparation(observation: WorkPreparationObservation): void {
		if (this.#closed) return;
		this.#enqueue({ type: "observation", observation });
	}

	resynchronizeAgent(runId: string, sequence: number): void {
		if (this.#closed) return;
		if (this.#runId !== runId) {
			this.#requireResynchronization();
			return;
		}
		this.#pending.clear();
		this.#nextSequence = Number.isSafeInteger(sequence) && sequence >= 0 ? sequence + 1 : 1;
		this.#highestSequence = Math.max(0, this.#nextSequence - 1);
		this.#requireResynchronization();
	}

	/**
	 * Ends this Worker's Observation epoch without waiting for presentation work.
	 *
	 * Any retained delivery is no longer valid once the Worker releases its
	 * Session lease. Invalidating it synchronously prevents a retired Runtime
	 * from publishing into a later owner of the same Session.
	 */
	invalidateAndClose(): void {
		if (this.#closed) return;
		const invalidated = this.#pending.size > 0 || this.#deliveries.size > 0;
		this.#closed = true;
		this.#pending.clear();
		this.#deliveries.close();
		this.#runId = undefined;
		if (invalidated) {
			try {
				this.#resynchronize();
			} catch {}
		}
	}

	#beginRun(runId: string): void {
		if (this.#runId === runId) return;
		if (this.#runId !== undefined) this.#requireResynchronization();
		this.#runId = runId;
		this.#pending.clear();
		this.#nextSequence = 1;
		this.#highestSequence = 0;
	}

	#promoteContiguous(): void {
		while (this.#pending.has(this.#nextSequence)) {
			const observation = this.#pending.get(this.#nextSequence);
			this.#pending.delete(this.#nextSequence);
			this.#nextSequence++;
			if (observation) this.#enqueue({ type: "observation", observation });
		}
	}

	#overflowAgentOrder(): void {
		this.#pending.clear();
		this.#nextSequence = this.#highestSequence + 1;
		this.#requireResynchronization();
	}

	#enqueue(delivery: Delivery): void {
		if (this.#closed) return;
		if (!this.#deliveries.enqueue(delivery)) {
			this.#requireResynchronization();
		}
	}

	#requireResynchronization(): void {
		if (this.#closed) return;
		this.#deliveries.replace({ type: "resynchronize" });
	}
}
