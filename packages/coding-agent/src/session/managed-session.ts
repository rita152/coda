import type { Agent, AgentEvent } from "@coda/agent";
import type { SessionRecord, SessionRecordType } from "./records.ts";
import { eventRecordInputs, reduceSession } from "./records.ts";
import type {
	DetachSession,
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
	readonly #seed;
	readonly #restored: RestoredSessionState;
	readonly #recoverableFollowUps;
	readonly #composerSubmissions;
	readonly #toolInvocations: readonly SessionToolLifecycle[];
	readonly #mediaReferences: ReadonlyMap<string, readonly SessionMediaReference[]>;
	#sequence: number;
	#previousRecordId: string | null;
	#attached?: Agent;
	#detach?: () => void;
	#closed = false;
	#preparedRun?: { readonly promptVersion: string; readonly promptSha256: string };
	#appendTail: Promise<void> = Promise.resolve();

	constructor(journal: SessionJournal, runtime: SessionRuntime) {
		this.#journal = journal;
		this.#runtime = runtime;
		const reduced = reduceSession(journal.records);
		this.#seed = structuredClone(reduced.seed);
		this.#restored = structuredClone(reduced.restored);
		this.#recoverableFollowUps = structuredClone(reduced.recoverableFollowUps);
		this.#composerSubmissions = structuredClone(reduced.composerSubmissions);
		this.#toolInvocations = structuredClone(reduced.toolInvocations);
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
		return structuredClone(this.#seed);
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

	get mediaReferences(): ReadonlyMap<string, readonly SessionMediaReference[]> {
		return new Map(
			[...this.#mediaReferences].map(([messageId, references]) => [messageId, structuredClone(references)]),
		);
	}

	registerMedia(registrations: readonly SessionMediaRegistration[]): void {
		this.#assertOpen();
		this.#journal.registerMedia?.(registrations);
	}

	attach(agent: Agent): DetachSession {
		this.#assertOpen();
		if (this.#attached) throw new Error("Session is already attached to an Agent");
		this.#attached = agent;
		this.#detach = agent.onEvent((event) => this.#recordEvent(event));
		return () => {
			this.#detach?.();
			this.#detach = undefined;
			this.#attached = undefined;
		};
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
		if (change.type === "composer_submission_recorded") {
			await this.#append("composer_submission_recorded", { submission: change.submission });
			return;
		}
		if (change.type === "composer_submission_retracted") {
			await this.#append("composer_submission_retracted", { id: change.id });
			return;
		}
		await this.#append(change.type, change.type === "follow_up_enqueued" ? { item: change.item } : { id: change.id });
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#detach?.();
		this.#detach = undefined;
		this.#attached = undefined;
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
		for (const input of eventRecordInputs(event, this.#preparedRun)) {
			await this.#append(input.type, input.payload, event);
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
		this.#previousRecordId = recordId;
	}

	#assertOpen(): void {
		if (this.#closed) throw new Error("Session is closed");
	}
}
