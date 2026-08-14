import type { AgentEvent, AgentMessage, FollowUp } from "@coda/agent";
import {
	projectSessionRunEvidence,
	type RunEvidenceEnvelope,
	RunEvidenceProjection,
	type RunEvidenceWorkspaceDiffSupplement,
	supplementRunEvidenceWorkspaceDiff,
} from "../run-evidence/run-evidence.ts";
import type { CompactionCheckpoint } from "./compaction.ts";
import type { SessionRecord, SessionRecordType } from "./records.ts";
import { compactionPayload, eventRecordInputs, reduceSession } from "./records.ts";
import { SessionHistoryReader } from "./session-history-reader.ts";
import type {
	RestoredSessionState,
	Session,
	SessionChange,
	SessionDescriptor,
	SessionMediaReference,
	SessionMediaRegistration,
	SessionRuntime,
	SessionToolLifecycle,
} from "./types.ts";

export interface SessionJournal {
	readonly descriptor: SessionDescriptor;
	readonly records: readonly SessionRecord[];
	readonly mediaReferences?: ReadonlyMap<string, readonly SessionMediaReference[]>;
	registerMedia?(registrations: readonly SessionMediaRegistration[]): void;
	append(record: SessionRecord): Promise<void>;
	close(): Promise<void>;
}

function identity(runtime: SessionRuntime, prefix: string): string {
	const value = runtime.idGenerator.generate("queue_item");
	if (!value) throw new Error(`Could not allocate ${prefix} identity`);
	return `${prefix}:${value}`;
}

export class ManagedSession implements Session {
	readonly #journal: SessionJournal;
	readonly #runtime: SessionRuntime;
	readonly #restored: RestoredSessionState;
	readonly #recoverableFollowUps;
	readonly #composerSubmissions;
	readonly #toolInvocations: readonly SessionToolLifecycle[];
	readonly #historyMessages: AgentMessage[];
	readonly #pendingFollowUps = new Map<string, FollowUp>();
	readonly #activeFollowUps = new Map<string, FollowUp>();
	readonly #history: SessionHistoryReader;
	readonly #liveRunEvidence = new RunEvidenceProjection();
	readonly #runEvidence: RunEvidenceEnvelope[];
	readonly #mediaReferences: ReadonlyMap<string, readonly SessionMediaReference[]>;
	#compactionCheckpoint?: CompactionCheckpoint;
	#discardedModelCost?: number;
	#sequence: number;
	#previousRecordId: string | null;
	#closed = false;
	#preparedRun?: { readonly promptVersion: string; readonly promptSha256: string };
	#appendTail: Promise<void> = Promise.resolve();

	constructor(journal: SessionJournal, runtime: SessionRuntime) {
		this.#journal = journal;
		this.#runtime = runtime;
		const reduced = reduceSession(journal.records);
		this.#restored = structuredClone(reduced.restored);
		this.#recoverableFollowUps = structuredClone(reduced.recoverableFollowUps);
		this.#composerSubmissions = structuredClone(reduced.composerSubmissions);
		this.#toolInvocations = structuredClone(reduced.toolInvocations);
		this.#historyMessages = [...structuredClone(reduced.seed.messages)];
		for (const item of reduced.seed.pendingFollowUps)
			this.#pendingFollowUps.set(String(item.id), structuredClone(item));
		this.#history = new SessionHistoryReader({
			sessionId: journal.descriptor.id,
			messages: () => this.#historyMessages,
		});
		this.#runEvidence = [...structuredClone(projectSessionRunEvidence(journal.records))];
		this.#compactionCheckpoint = reduced.compactionCheckpoint
			? structuredClone(reduced.compactionCheckpoint)
			: undefined;
		this.#discardedModelCost = reduced.discardedModelCost;
		this.#mediaReferences = new Map(
			[...(journal.mediaReferences ?? new Map())].map(([messageId, references]) => [
				messageId,
				structuredClone(references),
			]),
		);
		const last = journal.records.at(-1);
		this.#sequence = last?.sequence ?? 0;
		this.#previousRecordId = last?.recordId ?? null;
	}

	get descriptor(): SessionDescriptor {
		return this.#journal.descriptor;
	}

	get seed() {
		return structuredClone({
			version: 1 as const,
			messages: this.#historyMessages,
			pendingFollowUps: [...this.#pendingFollowUps.values()],
		});
	}

	get restored(): RestoredSessionState {
		return structuredClone(this.#restored);
	}

	get recoverableFollowUps() {
		return structuredClone(this.#recoverableFollowUps);
	}

	get composerSubmissions() {
		return structuredClone(this.#composerSubmissions);
	}

	get toolInvocations(): readonly SessionToolLifecycle[] {
		return structuredClone(this.#toolInvocations);
	}

	get history(): SessionHistoryReader {
		return this.#history;
	}

	get runEvidence(): readonly RunEvidenceEnvelope[] {
		return structuredClone(this.#runEvidence);
	}

	get compactionCheckpoint(): CompactionCheckpoint | undefined {
		return this.#compactionCheckpoint ? structuredClone(this.#compactionCheckpoint) : undefined;
	}

	get discardedModelCost(): number | undefined {
		return this.#discardedModelCost;
	}

	get mediaReferences(): ReadonlyMap<string, readonly SessionMediaReference[]> {
		return new Map(
			[...this.#mediaReferences].map(([messageId, references]) => [messageId, structuredClone(references)]),
		);
	}

	registerMedia(registrations: readonly SessionMediaRegistration[]): void {
		this.#assertOpen();
		this.#journal.registerMedia?.(registrations);
	}

	supplementRunEvidence(runId: string, supplement: RunEvidenceWorkspaceDiffSupplement): void {
		this.#assertOpen();
		let index = this.#runEvidence.length - 1;
		while (index >= 0 && this.#runEvidence[index]?.runId !== runId) index--;
		if (index < 0) return;
		this.#runEvidence[index] = supplementRunEvidenceWorkspaceDiff(this.#runEvidence[index]!, supplement);
	}

	accept(event: AgentEvent): Promise<void> {
		this.#assertOpen();
		return this.#recordEvent(event);
	}

	async record(change: SessionChange): Promise<void> {
		this.#assertOpen();
		if (change.type === "prepare_run") {
			this.#preparedRun = { promptVersion: change.promptVersion, promptSha256: change.promptSha256 };
			return;
		}
		if (change.type === "model_selected") {
			await this.#append("model_selected", { model: change.model, reasoning: change.reasoning });
			return;
		}
		if (change.type === "project_trust_changed") {
			await this.#append("project_trust_changed", { trust: change.trust });
			return;
		}
		if (change.type === "mcp_trust_changed") {
			await this.#append("mcp_trust_changed", { trust: change.trust });
			return;
		}
		if (change.type === "context_compacted") {
			const payload = compactionPayload(change.checkpoint);
			await this.#append("context_compacted", payload);
			this.#compactionCheckpoint = structuredClone(payload.checkpoint);
			return;
		}
		if (change.type === "composer_submission_recorded") {
			await this.#append("composer_submission_recorded", { submission: change.submission });
			return;
		}
		if (change.type === "composer_submission_retracted") {
			await this.#append("composer_submission_retracted", { id: change.id });
			return;
		}
		await this.#append(change.type, change.type === "follow_up_enqueued" ? { item: change.item } : { id: change.id });
		if (change.type === "follow_up_enqueued") {
			this.#pendingFollowUps.set(String(change.item.id), structuredClone(change.item));
		} else {
			this.#pendingFollowUps.delete(String(change.id));
		}
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		let failure: unknown;
		try {
			await this.#appendTail;
		} catch (error) {
			failure = error;
		}
		try {
			await this.#journal.close();
		} catch (error) {
			failure ??= error;
		}
		if (failure !== undefined) throw failure;
	}

	async #recordEvent(event: AgentEvent): Promise<void> {
		if (event.type === "run_start" && event.source === "follow_up" && event.queueItemId) {
			const pending = this.#pendingFollowUps.get(String(event.queueItemId));
			if (pending) {
				this.#activeFollowUps.set(String(event.runId), pending);
				this.#pendingFollowUps.delete(String(event.queueItemId));
			}
		}
		if (event.type === "attempt_end" && event.discarded) {
			const cost = event.candidate.message.usage.cost?.total;
			this.#discardedModelCost =
				this.#discardedModelCost === undefined || cost === undefined ? undefined : this.#discardedModelCost + cost;
		}
		for (const input of eventRecordInputs(event, this.#preparedRun)) {
			await this.#append(input.type, input.payload, event);
		}
		const evidence = this.#liveRunEvidence.accept(event);
		if (evidence) this.#runEvidence.push(evidence);
		if (event.type === "run_end") {
			const followUp = this.#activeFollowUps.get(String(event.runId));
			if (followUp && event.outcome === "aborted") this.#pendingFollowUps.set(String(followUp.id), followUp);
			this.#activeFollowUps.delete(String(event.runId));
		}
		if (event.type === "run_start") this.#preparedRun = undefined;
	}

	#append(type: SessionRecordType, payload: unknown, event?: AgentEvent): Promise<void> {
		const operation = this.#appendTail.then(() => this.#appendNow(type, payload, event));
		this.#appendTail = operation;
		return operation;
	}

	async #appendNow(type: SessionRecordType, payload: unknown, event?: AgentEvent): Promise<void> {
		const recordId = identity(this.#runtime, "record");
		const record: SessionRecord = {
			type,
			recordId,
			sessionId: this.descriptor.id,
			sequence: ++this.#sequence,
			previousRecordId: this.#previousRecordId,
			timestamp: event?.timestamp ?? this.#runtime.clock.now(),
			runId: event?.runId,
			turnId: event && "turnId" in event ? event.turnId : undefined,
			attemptId: event && "attemptId" in event ? event.attemptId : undefined,
			payload: structuredClone(payload),
		};
		await this.#journal.append(record);
		if (type === "message_committed") {
			const message = (payload as { readonly message?: AgentMessage }).message;
			if (message) this.#historyMessages.push(structuredClone(message));
		}
		this.#previousRecordId = recordId;
	}

	#assertOpen(): void {
		if (this.#closed) throw new Error("Session is closed");
	}
}
