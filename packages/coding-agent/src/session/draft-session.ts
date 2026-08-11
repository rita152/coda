import type { Agent, AgentSeed } from "@coda/agent";
import type { DetachSession, Session, SessionChange, SessionDescriptor, SessionMediaRegistration } from "./types.ts";

export interface DraftSessionOptions {
	readonly descriptor: SessionDescriptor;
	readonly materialize: () => Promise<Session>;
}

const EMPTY_SEED: AgentSeed = Object.freeze({
	version: 1,
	messages: Object.freeze([]),
	pendingFollowUps: Object.freeze([]),
});

/** A process-local Session facade that creates its durable journal on first mutation. */
export class DraftSession implements Session {
	readonly #draftDescriptor: SessionDescriptor;
	readonly #factory: () => Promise<Session>;
	#session?: Session;
	#materialization?: Promise<Session>;
	#materializationFailure?: unknown;
	#agent?: Agent;
	#detachAgent?: DetachSession;
	#registrations: SessionMediaRegistration[] = [];
	#initialChanges: SessionChange[] = [];
	#closed = false;

	constructor(options: DraftSessionOptions) {
		this.#draftDescriptor = structuredClone(options.descriptor);
		this.#factory = options.materialize;
	}

	get materialized(): boolean {
		return this.#session !== undefined;
	}

	get descriptor(): SessionDescriptor {
		return structuredClone(this.#session?.descriptor ?? this.#draftDescriptor);
	}

	get seed() {
		return structuredClone(this.#session?.seed ?? EMPTY_SEED);
	}

	get restored() {
		return structuredClone(this.#session?.restored ?? {});
	}

	get recoverableFollowUps() {
		return structuredClone(this.#session?.recoverableFollowUps ?? []);
	}

	get composerSubmissions() {
		return structuredClone(this.#session?.composerSubmissions ?? []);
	}

	get toolInvocations() {
		return structuredClone(this.#session?.toolInvocations ?? []);
	}

	get compactionCheckpoint() {
		return this.#session?.compactionCheckpoint ? structuredClone(this.#session.compactionCheckpoint) : undefined;
	}

	get mediaReferences() {
		return new Map(this.#session?.mediaReferences ?? []);
	}

	registerMedia(registrations: readonly SessionMediaRegistration[]): void {
		this.#assertOpen();
		if (this.#session) {
			this.#session.registerMedia(registrations);
			return;
		}
		this.#registrations.push(...structuredClone(registrations));
	}

	stageInitialChanges(changes: readonly SessionChange[]): void {
		this.#assertOpen();
		if (this.#session || this.#materialization) throw new Error("Draft Session is already materializing");
		this.#initialChanges.push(...structuredClone(changes));
	}

	attach(agent: Agent): DetachSession {
		this.#assertOpen();
		if (this.#agent) throw new Error("Session is already attached to an Agent");
		this.#agent = agent;
		if (this.#session) this.#detachAgent = this.#session.attach(agent);
		return () => {
			if (this.#agent !== agent) return;
			this.#detachAgent?.();
			this.#detachAgent = undefined;
			this.#agent = undefined;
		};
	}

	async record(change: SessionChange): Promise<void> {
		this.#assertOpen();
		const session = await this.#ensureMaterialized();
		await session.record(change);
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		if (this.#materialization) {
			try {
				await this.#materialization;
			} catch {}
		}
		await this.#session?.close();
	}

	async #ensureMaterialized(): Promise<Session> {
		if (this.#materialization) return this.#materialization;
		if (this.#session) return this.#session;
		if (this.#materializationFailure !== undefined) throw this.#materializationFailure;
		this.#materialization = this.#createMaterializedSession().catch((error: unknown) => {
			this.#materializationFailure = error;
			throw error;
		});
		return this.#materialization;
	}

	async #createMaterializedSession(): Promise<Session> {
		const session = await this.#factory();
		if (session.descriptor.id !== this.#draftDescriptor.id) {
			await session.close().catch(() => undefined);
			throw new Error("Materialized Session identity does not match its Draft");
		}
		if (
			session.descriptor.workspace.id !== this.#draftDescriptor.workspace.id ||
			session.descriptor.workspace.path !== this.#draftDescriptor.workspace.path
		) {
			await session.close().catch(() => undefined);
			throw new Error("Materialized Session belongs to a different Workspace");
		}
		this.#session = session;
		try {
			if (this.#registrations.length > 0) session.registerMedia(this.#registrations);
			this.#registrations = [];
			for (const change of this.#initialChanges) await session.record(change);
			this.#initialChanges = [];
			if (this.#agent) this.#detachAgent = session.attach(this.#agent);
			return session;
		} catch (error) {
			this.#session = undefined;
			await session.close().catch(() => undefined);
			throw error;
		}
	}

	#assertOpen(): void {
		if (this.#closed) throw new Error("Session is closed");
	}
}
