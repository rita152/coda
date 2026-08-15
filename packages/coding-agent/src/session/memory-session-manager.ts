import { ManagedSession, type SessionJournal } from "./managed-session.ts";
import type { SessionHeader, SessionRecord } from "./records.ts";
import { descriptorHeader } from "./records.ts";
import type {
	OpenSessionRequest,
	Session,
	SessionDescriptor,
	SessionId,
	SessionManager,
	SessionRuntime,
	SessionWorkspace,
} from "./types.ts";

interface MemoryJournalData {
	readonly header: SessionHeader;
	readonly descriptor: SessionDescriptor;
	readonly records: SessionRecord[];
	open: boolean;
}

function allocateSessionId(runtime: SessionRuntime): SessionId {
	return `session:${runtime.idGenerator.generate("queue_item")}` as SessionId;
}

export class InMemorySessionManager implements SessionManager {
	readonly #runtime: SessionRuntime;
	readonly #journals = new Map<string, MemoryJournalData>();

	constructor(runtime: SessionRuntime) {
		this.#runtime = runtime;
	}

	async open(request: OpenSessionRequest): Promise<Session> {
		if (request.resumeId && request.createId)
			throw new Error("A Session cannot be resumed and created simultaneously");
		const data = request.resumeId
			? this.#journals.get(request.resumeId)
			: this.#create(request.workspace, request.createId ? String(request.createId) : undefined);
		if (!data) throw new Error(`Session not found: ${request.resumeId}`);
		if (
			data.descriptor.workspace.id !== request.workspace.id ||
			data.descriptor.workspace.path !== request.workspace.path
		) {
			throw new Error("Session belongs to a different Workspace");
		}
		if (data.open) throw new Error(`Session is already open: ${data.descriptor.id}`);
		data.open = true;
		const journal: SessionJournal = {
			descriptor: data.descriptor,
			records: data.records.map((record) => structuredClone(record)),
			append: async (record) => {
				data.records.push(structuredClone(record));
			},
			close: async () => {
				data.open = false;
			},
		};
		return new ManagedSession(journal, this.#runtime);
	}

	async list(workspace: SessionWorkspace): Promise<readonly SessionDescriptor[]> {
		return [...this.#journals.values()]
			.filter(
				(data) =>
					data.descriptor.workspace.id === workspace.id && data.descriptor.workspace.path === workspace.path,
			)
			.map((data) => structuredClone(data.descriptor))
			.sort((left, right) => right.createdAt - left.createdAt);
	}

	#create(workspace: SessionWorkspace, requestedId?: string): MemoryJournalData {
		const existing = requestedId ? this.#journals.get(requestedId) : undefined;
		if (existing?.open) throw new Error(`Session is already open: ${requestedId}`);
		if (existing && !existing.descriptor.persistent) this.#journals.delete(requestedId!);
		const descriptor: SessionDescriptor = {
			id: (requestedId || allocateSessionId(this.#runtime)) as SessionId,
			workspace: structuredClone(workspace),
			createdAt: this.#runtime.clock.now(),
			persistent: false,
		};
		if (this.#journals.has(descriptor.id)) throw new Error("Session IdGenerator returned a duplicate identity");
		const data: MemoryJournalData = {
			header: descriptorHeader(descriptor),
			descriptor,
			records: [],
			open: false,
		};
		this.#journals.set(descriptor.id, data);
		return data;
	}
}
