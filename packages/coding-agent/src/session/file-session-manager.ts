import { join } from "node:path";
import type { DiagnosticSink } from "@coda/tui";
import type { DirectoryEntry, FileSystem } from "../host/file-system.ts";
import { isFileSystemError } from "../host/file-system.ts";
import { ManagedSession, type SessionJournal } from "./managed-session.ts";
import { SessionMediaCodec } from "./media-codec.ts";
import { descriptorHeader, type SessionRecord } from "./records.ts";
import { SessionCodecRegistry } from "./session-codec-registry.ts";
import { type SessionJournalAppender, SessionJournalStore } from "./session-journal-store.ts";
import { type ProcessInspector, SessionLease, type SessionLockOwner } from "./session-lease.ts";
import { hasRetainedSessionActivity, isProvisionalSessionRecord } from "./session-lifecycle.ts";
import {
	type InterruptedToolRecovery,
	type InterruptedToolRecoveryCatalog,
	SessionRecovery,
} from "./session-recovery.ts";
import { summarizeSessionRecords } from "./session-summary.ts";
import type {
	OpenSessionRequest,
	Session,
	SessionDescriptor,
	SessionId,
	SessionManager,
	SessionMediaReference,
	SessionRuntime,
	SessionSummary,
	SessionWorkspace,
} from "./types.ts";

export interface FileSessionManagerOptions extends SessionRuntime {
	readonly fileSystem: FileSystem;
	readonly homeDirectory: string;
	readonly owner: SessionLockOwner;
	readonly processInspector: ProcessInspector;
	readonly diagnostics?: DiagnosticSink;
	readonly interruptedToolRecovery?: InterruptedToolRecovery;
	readonly recoveryTools?: InterruptedToolRecoveryCatalog;
}

interface ListedSessionJournal {
	readonly descriptor: SessionDescriptor;
	readonly records: readonly SessionRecord[];
}

/** Composes the journal, codec, lease, media, and recovery Session subsystems. */
export class FileSessionManager implements SessionManager {
	readonly #fileSystem: FileSystem;
	readonly #homeDirectory: string;
	readonly #runtime: SessionRuntime;
	readonly #owner: SessionLockOwner;
	readonly #processInspector: ProcessInspector;
	readonly #diagnostics?: DiagnosticSink;
	readonly #store: SessionJournalStore;
	readonly #codecs: SessionCodecRegistry;
	readonly #recovery: SessionRecovery;

	constructor(options: FileSessionManagerOptions) {
		this.#fileSystem = options.fileSystem;
		this.#homeDirectory = options.homeDirectory;
		this.#runtime = { clock: options.clock, idGenerator: options.idGenerator };
		this.#owner = { ...options.owner };
		this.#processInspector = options.processInspector;
		this.#diagnostics = options.diagnostics;
		this.#store = new SessionJournalStore({ fileSystem: options.fileSystem, idGenerator: options.idGenerator });
		this.#codecs = new SessionCodecRegistry({ store: this.#store, diagnostics: options.diagnostics });
		this.#recovery = new SessionRecovery({
			runtime: this.#runtime,
			diagnostics: options.diagnostics,
			interruptedToolRecovery: options.interruptedToolRecovery,
			recoveryTools: options.recoveryTools,
		});
	}

	async open(request: OpenSessionRequest): Promise<Session> {
		if (request.resumeId && request.createId) {
			throw new Error("A Session cannot be resumed and created simultaneously");
		}
		const directory = this.#workspaceDirectory(request.workspace);
		await this.#store.prepareWorkspaceDirectory(this.#homeDirectory, directory);
		const sessionId = request.resumeId
			? this.#validateSessionId(String(request.resumeId))
			: request.createId
				? this.#validateSessionId(String(request.createId))
				: (`session-${safeIdentity(this.#runtime.idGenerator.generate("queue_item"))}` as SessionId);
		const path = join(directory, `${sessionId}.jsonl`);
		const mediaCodec = new SessionMediaCodec({
			fileSystem: this.#fileSystem,
			mediaDirectory: `${path}.media`,
			idGenerator: this.#runtime.idGenerator,
		});
		const lease = new SessionLease({
			fileSystem: this.#fileSystem,
			lockPath: `${path}.lock`,
			sessionId,
			owner: this.#owner,
			processInspector: this.#processInspector,
			now: () => this.#runtime.clock.now(),
		});
		await lease.acquire(request);
		let appender: SessionJournalAppender | undefined;
		const provisionalRecords: SessionRecord[] = [];
		try {
			let descriptor: SessionDescriptor;
			let records: readonly SessionRecord[];
			let mediaReferences: ReadonlyMap<string, readonly SessionMediaReference[]> = new Map();
			if (request.resumeId) {
				const parsed = await this.#codecs.readCurrent(path, mediaCodec);
				if (
					parsed.header.workspaceId !== request.workspace.id ||
					parsed.header.workspacePath !== request.workspace.path ||
					parsed.header.sessionId !== sessionId
				) {
					throw new Error("Session belongs to a different Workspace");
				}
				mediaReferences = mediaCodec.collectReferences(parsed.records);
				const hydrated: SessionRecord[] = [];
				for (const record of parsed.records) hydrated.push(await mediaCodec.hydrateRecord(record));
				records = hydrated;
				descriptor = {
					id: sessionId,
					workspace: { ...request.workspace },
					createdAt: parsed.header.createdAt,
					persistent: true,
					path,
				};
			} else {
				await this.#store.assertAvailable(path);
				descriptor = {
					id: sessionId,
					workspace: { ...request.workspace },
					createdAt: this.#runtime.clock.now(),
					persistent: true,
					path,
				};
				records = [];
			}

			if (request.resumeId) appender = await this.#store.openAppender(path);
			const append = async (record: SessionRecord): Promise<void> => {
				const encoded = await mediaCodec.encodeRecord(record);
				if (appender) {
					await appender.append(encoded);
					return;
				}
				provisionalRecords.push(encoded);
				if (isProvisionalSessionRecord(record)) return;
				appender = await this.#store.materialize(path, descriptorHeader(descriptor), provisionalRecords);
				provisionalRecords.length = 0;
			};
			records = await this.#recovery.recover({
				records,
				sessionId,
				path,
				mode: request.mode,
				workspace: request.workspace,
				append,
			});
			const journal: SessionJournal = {
				descriptor,
				records,
				mediaReferences,
				registerMedia: (registrations) => mediaCodec.register(registrations),
				append,
				close: async () => {
					let failure: unknown;
					try {
						await appender?.close();
						appender = undefined;
					} catch (error) {
						failure = error;
					}
					try {
						await lease.release();
					} catch (error) {
						failure ??= error;
					}
					if (failure !== undefined) throw failure;
				},
			};
			return new ManagedSession(journal, this.#runtime);
		} catch (error) {
			await appender?.close().catch(() => undefined);
			await lease.release().catch(() => undefined);
			throw error;
		}
	}

	async list(workspace: SessionWorkspace): Promise<readonly SessionDescriptor[]> {
		return (await this.#listJournals(workspace))
			.filter(({ records }) => hasRetainedSessionActivity(records))
			.map(({ descriptor }) => descriptor)
			.sort((left, right) => right.createdAt - left.createdAt);
	}

	async listSummaries(workspace: SessionWorkspace): Promise<readonly SessionSummary[]> {
		return (await this.#listJournals(workspace))
			.filter(({ records }) => hasRetainedSessionActivity(records))
			.map(({ descriptor, records }) => summarizeSessionRecords(descriptor, records))
			.sort((left, right) => right.updatedAt - left.updatedAt);
	}

	async #listJournals(workspace: SessionWorkspace): Promise<readonly ListedSessionJournal[]> {
		const directory = this.#workspaceDirectory(workspace);
		let entries: readonly DirectoryEntry[];
		try {
			entries = await this.#store.readDirectory(directory);
		} catch (error) {
			if (isFileSystemError(error, "ENOENT")) return [];
			throw error;
		}
		const journals: ListedSessionJournal[] = [];
		for (const entry of entries) {
			if (entry.kind !== "file" || !entry.name.endsWith(".jsonl")) continue;
			const path = join(directory, entry.name);
			try {
				const parsed = await this.#codecs.read(path);
				if (parsed.header.workspaceId !== workspace.id || parsed.header.workspacePath !== workspace.path) continue;
				journals.push({
					descriptor: {
						id: parsed.header.sessionId as SessionId,
						workspace: { ...workspace },
						createdAt: parsed.header.createdAt,
						persistent: true,
						path,
					},
					records: parsed.records,
				});
			} catch (error) {
				await this.#diagnostics?.({
					code: "session.list-invalid",
					message: error instanceof Error ? error.message : String(error),
					details: { path },
				});
			}
		}
		return journals;
	}

	#workspaceDirectory(workspace: SessionWorkspace): string {
		if (!/^[a-zA-Z0-9._-]+$/.test(workspace.id)) throw new Error("Workspace identity is not path-safe");
		return join(this.#homeDirectory, ".coda", "sessions", workspace.id);
	}

	#validateSessionId(value: string): SessionId {
		if (!/^session-[a-zA-Z0-9._-]+$/.test(value)) throw new Error("Session identity is not path-safe");
		return value as SessionId;
	}
}

function safeIdentity(value: string): string {
	const safe = value.replace(/[^a-zA-Z0-9._-]/g, "-");
	if (!safe) throw new Error("IdGenerator returned an invalid Session identity");
	return safe;
}
