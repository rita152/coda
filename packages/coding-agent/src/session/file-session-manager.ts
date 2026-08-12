import { join } from "node:path";
import type { AgentMessage, ToolInvocation } from "@coda/agent";
import type { DiagnosticSink } from "@coda/tui";
import type { DirectoryEntry, FileSystem, WritableFile } from "../host/file-system.ts";
import { isFileSystemError } from "../host/file-system.ts";
import { ManagedSession, type SessionJournal } from "./managed-session.ts";
import { SessionMediaCodec } from "./media-codec.ts";
import {
	descriptorHeader,
	messagePayload,
	reduceSession,
	SESSION_RECORD_TYPES,
	type SessionHeader,
	type SessionRecord,
	type SessionRecordType,
} from "./records.ts";
import type {
	OpenSessionRequest,
	Session,
	SessionDescriptor,
	SessionId,
	SessionManager,
	SessionMediaReference,
	SessionRuntime,
	SessionWorkspace,
} from "./types.ts";
import { isSessionHeader, isSessionRecordEnvelope, isSessionRecordPayload } from "./v1-schema.ts";

export type ProcessStatus = "alive" | "dead" | "unknown";

export interface SessionLockOwner {
	readonly token: string;
	readonly pid: number;
	readonly processStartedAt: number;
	readonly hostname: string;
}

export interface ProcessInspector {
	status(owner: Pick<SessionLockOwner, "pid" | "processStartedAt">): Promise<ProcessStatus>;
}

export interface FileSessionManagerOptions extends SessionRuntime {
	readonly fileSystem: FileSystem;
	readonly homeDirectory: string;
	readonly owner: SessionLockOwner;
	readonly processInspector: ProcessInspector;
	readonly diagnostics?: DiagnosticSink;
	readonly interruptedToolRecovery?: InterruptedToolRecovery;
}

export interface InterruptedToolRecoveryRequest {
	readonly invocation: ToolInvocation;
	readonly runId?: string;
	readonly turnId?: string;
	readonly startedAt: number;
}

export type InterruptedToolRecovery = (request: InterruptedToolRecoveryRequest) => Promise<"cancel" | "skip">;

interface LockFile extends SessionLockOwner {
	readonly sessionId: string;
	readonly createdAt: number;
}

interface ParsedJournal {
	readonly header: SessionHeader;
	readonly records: readonly SessionRecord[];
	readonly sourceText: string;
}

const RECORD_TYPES = new Set<string>(SESSION_RECORD_TYPES);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeIdentity(value: string): string {
	const safe = value.replace(/[^a-zA-Z0-9._-]/g, "-");
	if (!safe) throw new Error("IdGenerator returned an invalid Session identity");
	return safe;
}

function parseLock(value: string): LockFile {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new Error("Session lock is corrupt; ownership is uncertain");
	}
	if (
		!isRecord(parsed) ||
		typeof parsed.token !== "string" ||
		typeof parsed.pid !== "number" ||
		typeof parsed.processStartedAt !== "number" ||
		typeof parsed.hostname !== "string" ||
		typeof parsed.sessionId !== "string" ||
		typeof parsed.createdAt !== "number"
	) {
		throw new Error("Session lock is invalid; ownership is uncertain");
	}
	return parsed as unknown as LockFile;
}

function parseJournal(text: string, path: string, diagnostics?: DiagnosticSink): ParsedJournal {
	const complete = text.endsWith("\n");
	const lines = text.split("\n");
	if (complete) lines.pop();
	else {
		const truncated = lines.pop();
		if (truncated !== undefined) {
			void diagnostics?.({
				code: "session.truncated-final-record",
				message: "Ignored a truncated final Session record without rewriting the journal",
				details: { path },
			});
		}
	}
	if (lines.length === 0) throw new Error("Session journal has no complete header");
	let headerValue: unknown;
	try {
		headerValue = JSON.parse(lines[0]!);
	} catch {
		throw new Error("Session header is invalid JSON");
	}
	if (!isSessionHeader(headerValue)) {
		throw new Error("Unsupported or invalid Session header");
	}
	const header = headerValue as unknown as SessionHeader;
	const records: SessionRecord[] = [];
	const recordIds = new Set<string>();
	let previousRecordId: string | null = null;
	for (let index = 1; index < lines.length; index++) {
		let value: unknown;
		try {
			value = JSON.parse(lines[index]!);
		} catch {
			throw new Error(`Session record ${index} is invalid JSON`);
		}
		if (
			!isSessionRecordEnvelope(value) ||
			!RECORD_TYPES.has(value.type) ||
			value.sessionId !== header.sessionId ||
			value.sequence !== index ||
			value.previousRecordId !== previousRecordId ||
			!("payload" in value)
		) {
			throw new Error(`Session record ${index} violates the v1 linear schema`);
		}
		if (!isSessionRecordPayload(value.type as SessionRecordType, value.payload, header.version)) {
			throw new Error(`Session record ${index} violates its v${header.version} typed payload schema`);
		}
		if (recordIds.has(value.recordId)) throw new Error(`Session record ${index} repeats an identity`);
		recordIds.add(value.recordId);
		previousRecordId = value.recordId;
		records.push(value as unknown as SessionRecord);
	}
	return { header, records, sourceText: text };
}

function collectMediaReferences(
	records: readonly SessionRecord[],
): ReadonlyMap<string, readonly SessionMediaReference[]> {
	const references = new Map<string, readonly SessionMediaReference[]>();
	for (const record of records) {
		let ownerId: string | undefined;
		let content: unknown;
		if (record.type === "message_committed") {
			const message = (record.payload as { message?: { id?: unknown; message?: { content?: unknown } } }).message;
			if (typeof message?.id === "string") {
				ownerId = message.id;
				content = message.message?.content;
			}
		} else if (record.type === "follow_up_enqueued") {
			const item = (record.payload as { item?: { id?: unknown; content?: unknown } }).item;
			if (typeof item?.id === "string") {
				ownerId = item.id;
				content = item.content;
			}
		}
		if (!ownerId) continue;
		const media = collectMediaFromValue(content);
		if (media.length > 0) references.set(ownerId, structuredClone(media));
	}
	return references;
}

function collectMediaFromValue(value: unknown): SessionMediaReference[] {
	if (Array.isArray(value)) return value.flatMap(collectMediaFromValue);
	if (typeof value !== "object" || value === null) return [];
	if ((value as { type?: unknown }).type === "media") return [value as SessionMediaReference];
	return Object.values(value).flatMap(collectMediaFromValue);
}

export class FileSessionManager implements SessionManager {
	readonly #fileSystem: FileSystem;
	readonly #homeDirectory: string;
	readonly #runtime: SessionRuntime;
	readonly #owner: SessionLockOwner;
	readonly #processInspector: ProcessInspector;
	readonly #diagnostics?: DiagnosticSink;
	readonly #interruptedToolRecovery?: InterruptedToolRecovery;

	constructor(options: FileSessionManagerOptions) {
		this.#fileSystem = options.fileSystem;
		this.#homeDirectory = options.homeDirectory;
		this.#runtime = { clock: options.clock, idGenerator: options.idGenerator };
		this.#owner = { ...options.owner };
		this.#processInspector = options.processInspector;
		this.#diagnostics = options.diagnostics;
		this.#interruptedToolRecovery = options.interruptedToolRecovery;
	}

	async open(request: OpenSessionRequest): Promise<Session> {
		if (request.resumeId && request.createId)
			throw new Error("A Session cannot be resumed and created simultaneously");
		const directory = this.#workspaceDirectory(request.workspace);
		await this.#prepareDirectory(directory);
		const sessionId = request.resumeId
			? this.#validateSessionId(String(request.resumeId))
			: request.createId
				? this.#validateSessionId(String(request.createId))
				: (`session-${safeIdentity(this.#runtime.idGenerator.generate("queue_item"))}` as SessionId);
		const path = join(directory, `${sessionId}.jsonl`);
		const lockPath = `${path}.lock`;
		const mediaCodec = new SessionMediaCodec({
			fileSystem: this.#fileSystem,
			mediaDirectory: `${path}.media`,
			idGenerator: this.#runtime.idGenerator,
		});
		await this.#acquireLock(lockPath, sessionId, request);
		let appendHandle: WritableFile | undefined;
		try {
			let descriptor: SessionDescriptor;
			let records: readonly SessionRecord[];
			let parsedMediaReferences: ReadonlyMap<string, readonly SessionMediaReference[]> = new Map();
			let interruptedRunIds: readonly string[] = [];
			const recoveryInputs: Array<{
				type: "message_committed" | "tool_finished";
				payload: unknown;
				runId?: string;
				turnId?: string;
			}> = [];
			if (request.resumeId) {
				let parsed = await this.#readJournal(path);
				if (parsed.header.version === 1) parsed = await this.#migrateV1(path, parsed, mediaCodec);
				else if (parsed.header.version === 2) parsed = await this.#migrateV2(path, parsed);
				else if (parsed.header.version === 3) parsed = await this.#migrateV3(path, parsed);
				else if (parsed.header.version === 4) parsed = await this.#migrateV4(path, parsed);
				else if (parsed.header.version === 5) parsed = await this.#migrateV5(path, parsed);
				else if (parsed.header.version === 6) parsed = await this.#migrateV6(path, parsed);
				else if (parsed.header.version === 7) parsed = await this.#migrateV7(path, parsed);
				else if (parsed.header.version === 8) parsed = await this.#migrateV8(path, parsed);
				parsedMediaReferences = collectMediaReferences(parsed.records);
				if (
					parsed.header.workspaceId !== request.workspace.id ||
					parsed.header.workspacePath !== request.workspace.path ||
					parsed.header.sessionId !== sessionId
				) {
					throw new Error("Session belongs to a different Workspace");
				}
				const hydratedRecords: SessionRecord[] = [];
				for (const record of parsed.records) hydratedRecords.push(await mediaCodec.hydrateRecord(record));
				const reduced = reduceSession(hydratedRecords);
				if (reduced.startedTools.size > 0) {
					if (request.mode === "print" || !this.#interruptedToolRecovery) {
						throw new Error(
							`Session has ${reduced.startedTools.size} Interrupted Tool Invocation(s); automatic replay is forbidden`,
						);
					}
					for (const started of reduced.startedTools.values()) {
						const invocation = (started.payload as { invocation?: ToolInvocation }).invocation;
						if (
							!invocation ||
							typeof invocation.id !== "string" ||
							typeof invocation.resultMessageId !== "string" ||
							typeof invocation.providerToolCallId !== "string" ||
							typeof invocation.toolName !== "string"
						) {
							throw new Error("Interrupted Tool Invocation is missing required identities");
						}
						const decision = await this.#interruptedToolRecovery({
							invocation: structuredClone(invocation),
							runId: started.runId,
							turnId: started.turnId,
							startedAt: started.timestamp,
						});
						if (decision !== "skip") throw new Error("Interrupted Tool recovery was cancelled");
						const result: AgentMessage = {
							id: invocation.resultMessageId,
							message: {
								role: "toolResult",
								toolCallId: invocation.providerToolCallId,
								toolName: invocation.toolName,
								content: [
									{
										type: "text",
										text: "Interrupted Tool Invocation was skipped during Session recovery; prior side effects are unknown.",
									},
								],
								details: { interrupted: true, recovery: "skipped", sideEffects: "unknown" },
								isError: true,
								timestamp: this.#runtime.clock.now(),
							},
						};
						recoveryInputs.push(
							{
								type: "tool_finished",
								payload: {
									invocation,
									outcome: "interrupted",
									reason: "skipped_by_user",
									resultMessageId: invocation.resultMessageId,
								},
								runId: started.runId,
								turnId: started.turnId,
							},
							{
								type: "message_committed",
								payload: messagePayload(result),
								runId: started.runId,
								turnId: started.turnId,
							},
						);
					}
				}
				interruptedRunIds = [...reduced.activeRuns].sort();
				descriptor = {
					id: sessionId,
					workspace: { ...request.workspace },
					createdAt: parsed.header.createdAt,
					persistent: true,
					path,
				};
				records = hydratedRecords;
			} else {
				descriptor = {
					id: sessionId,
					workspace: { ...request.workspace },
					createdAt: this.#runtime.clock.now(),
					persistent: true,
					path,
				};
				const headerHandle = await this.#fileSystem.open(path, "wx", 0o600);
				try {
					await headerHandle.write(`${JSON.stringify(descriptorHeader(descriptor))}\n`);
					await headerHandle.sync();
				} finally {
					await headerHandle.close();
				}
				await this.#fileSystem.setMode(path, 0o600);
				records = [];
			}
			appendHandle = await this.#fileSystem.open(path, "a", 0o600);
			if (recoveryInputs.length > 0 || interruptedRunIds.length > 0) {
				const recovered = [...records];
				let sequence = recovered.at(-1)?.sequence ?? 0;
				let previousRecordId = recovered.at(-1)?.recordId ?? null;
				for (const input of recoveryInputs) {
					const record: SessionRecord = {
						type: input.type,
						recordId: `record:${safeIdentity(this.#runtime.idGenerator.generate("queue_item"))}`,
						sessionId,
						sequence: ++sequence,
						previousRecordId,
						timestamp: this.#runtime.clock.now(),
						runId: input.runId,
						turnId: input.turnId,
						payload: structuredClone(input.payload),
					};
					await appendHandle.write(`${JSON.stringify(await mediaCodec.encodeRecord(record))}\n`);
					await appendHandle.sync();
					recovered.push(record);
					previousRecordId = record.recordId;
				}
				for (const runId of interruptedRunIds) {
					const record: SessionRecord = {
						type: "run_finished",
						recordId: `record:${safeIdentity(this.#runtime.idGenerator.generate("queue_item"))}`,
						sessionId,
						sequence: ++sequence,
						previousRecordId,
						timestamp: this.#runtime.clock.now(),
						runId,
						payload: { outcome: "interrupted", reason: "process_ended_before_run_finished" },
					};
					await appendHandle.write(`${JSON.stringify(await mediaCodec.encodeRecord(record))}\n`);
					await appendHandle.sync();
					recovered.push(record);
					previousRecordId = record.recordId;
					await this.#diagnostics?.({
						code: "session.run-interrupted",
						message: "Recovered an active Run as interrupted",
						details: { path, runId },
					});
				}
				records = recovered;
			}
			const journal: SessionJournal = {
				descriptor,
				records,
				mediaReferences: parsedMediaReferences,
				registerMedia: (registrations) => mediaCodec.register(registrations),
				append: async (record) => {
					await appendHandle?.write(`${JSON.stringify(await mediaCodec.encodeRecord(record))}\n`);
					await appendHandle?.sync();
				},
				close: async () => {
					await appendHandle?.close();
					appendHandle = undefined;
					await this.#releaseLock(lockPath);
				},
			};
			return new ManagedSession(journal, this.#runtime);
		} catch (error) {
			await appendHandle?.close().catch(() => undefined);
			await this.#releaseLock(lockPath).catch(() => undefined);
			throw error;
		}
	}

	async list(workspace: SessionWorkspace): Promise<readonly SessionDescriptor[]> {
		const directory = this.#workspaceDirectory(workspace);
		let entries: readonly DirectoryEntry[];
		try {
			entries = await this.#fileSystem.readDirectory(directory);
		} catch (error) {
			if (isFileSystemError(error, "ENOENT")) return [];
			throw error;
		}
		const descriptors: SessionDescriptor[] = [];
		for (const entry of entries) {
			if (entry.kind !== "file" || !entry.name.endsWith(".jsonl")) continue;
			const path = join(directory, entry.name);
			try {
				const parsed = await this.#readJournal(path);
				if (parsed.header.workspaceId !== workspace.id || parsed.header.workspacePath !== workspace.path) continue;
				descriptors.push({
					id: parsed.header.sessionId as SessionId,
					workspace: { ...workspace },
					createdAt: parsed.header.createdAt,
					persistent: true,
					path,
				});
			} catch (error) {
				await this.#diagnostics?.({
					code: "session.list-invalid",
					message: error instanceof Error ? error.message : String(error),
					details: { path },
				});
			}
		}
		return descriptors.sort((left, right) => right.createdAt - left.createdAt);
	}

	#workspaceDirectory(workspace: SessionWorkspace): string {
		if (!/^[a-zA-Z0-9._-]+$/.test(workspace.id)) throw new Error("Workspace identity is not path-safe");
		return join(this.#homeDirectory, ".coda", "sessions", workspace.id);
	}

	#validateSessionId(value: string): SessionId {
		if (!/^session-[a-zA-Z0-9._-]+$/.test(value)) throw new Error("Session identity is not path-safe");
		return value as SessionId;
	}

	async #prepareDirectory(directory: string): Promise<void> {
		await this.#fileSystem.makeDirectory(directory, { recursive: true, mode: 0o700 });
		await this.#fileSystem.setMode(join(this.#homeDirectory, ".coda"), 0o700);
		await this.#fileSystem.setMode(join(this.#homeDirectory, ".coda", "sessions"), 0o700);
		await this.#fileSystem.setMode(directory, 0o700);
	}

	async #migrateV1(path: string, legacy: ParsedJournal, mediaCodec: SessionMediaCodec): Promise<ParsedJournal> {
		const records: SessionRecord[] = [];
		for (const record of legacy.records) records.push(await mediaCodec.encodeRecord(record));
		return this.#installMigration(path, legacy, records, 1);
	}

	async #migrateV2(path: string, legacy: ParsedJournal): Promise<ParsedJournal> {
		return this.#installMigration(path, legacy, legacy.records, 2);
	}

	async #migrateV3(path: string, legacy: ParsedJournal): Promise<ParsedJournal> {
		return this.#installMigration(path, legacy, legacy.records, 3);
	}

	async #migrateV4(path: string, legacy: ParsedJournal): Promise<ParsedJournal> {
		return this.#installMigration(path, legacy, legacy.records, 4);
	}

	async #migrateV5(path: string, legacy: ParsedJournal): Promise<ParsedJournal> {
		return this.#installMigration(path, legacy, legacy.records, 5);
	}

	async #migrateV6(path: string, legacy: ParsedJournal): Promise<ParsedJournal> {
		return this.#installMigration(path, legacy, legacy.records, 6);
	}

	async #migrateV7(path: string, legacy: ParsedJournal): Promise<ParsedJournal> {
		return this.#installMigration(path, legacy, legacy.records, 7);
	}

	async #migrateV8(path: string, legacy: ParsedJournal): Promise<ParsedJournal> {
		return this.#installMigration(path, legacy, legacy.records, 8);
	}

	async #installMigration(
		path: string,
		legacy: ParsedJournal,
		records: readonly SessionRecord[],
		fromVersion: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8,
	): Promise<ParsedJournal> {
		const header: SessionHeader = { ...legacy.header, version: 9 };
		const migratedText = `${[header, ...records].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
		const validated = parseJournal(migratedText, path, this.#diagnostics);
		const token = safeIdentity(this.#runtime.idGenerator.generate("queue_item"));
		const temporaryPath = `${path}.migrate-${token}.tmp`;
		let temporaryHandle: WritableFile | undefined;
		let installed = false;
		try {
			temporaryHandle = await this.#fileSystem.open(temporaryPath, "wx", 0o600);
			await temporaryHandle.write(migratedText);
			await temporaryHandle.sync();
			await temporaryHandle.close();
			temporaryHandle = undefined;
			const temporaryText = new TextDecoder("utf-8", { fatal: true }).decode(
				await this.#fileSystem.readFile(temporaryPath),
			);
			parseJournal(temporaryText, temporaryPath);

			const backupPath = `${path}.v${fromVersion}.backup`;
			if (await this.#exists(backupPath)) {
				const existing = new TextDecoder().decode(await this.#fileSystem.readFile(backupPath));
				if (existing !== legacy.sourceText)
					throw new Error(`Existing Session v${fromVersion} backup does not match the journal`);
			} else {
				const backupHandle = await this.#fileSystem.open(backupPath, "wx", 0o600);
				try {
					await backupHandle.write(legacy.sourceText);
					await backupHandle.sync();
				} finally {
					await backupHandle.close();
				}
				await this.#fileSystem.setMode(backupPath, 0o600);
			}

			await this.#fileSystem.rename(temporaryPath, path);
			await this.#fileSystem.setMode(path, 0o600);
			installed = true;
		} finally {
			await temporaryHandle?.close().catch(() => undefined);
			if (!installed) {
				try {
					await this.#fileSystem.removeFile(temporaryPath);
				} catch {}
			}
		}
		await this.#diagnostics?.({
			code: "session.migrated-v9",
			message: `Migrated a Session v${fromVersion} journal to Session v9`,
			details: { path, backupPath: `${path}.v${fromVersion}.backup`, fromVersion },
		});
		return validated;
	}

	async #exists(path: string): Promise<boolean> {
		try {
			await this.#fileSystem.stat(path);
			return true;
		} catch (error) {
			if (isFileSystemError(error, "ENOENT")) return false;
			throw error;
		}
	}

	async #readJournal(path: string): Promise<ParsedJournal> {
		let bytes: Uint8Array;
		try {
			bytes = await this.#fileSystem.readFile(path);
		} catch (error) {
			if (isFileSystemError(error, "ENOENT")) throw new Error(`Session not found: ${path}`);
			throw error;
		}
		let text: string;
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch {
			throw new Error("Session journal is not valid UTF-8");
		}
		return parseJournal(text, path, this.#diagnostics);
	}

	async #acquireLock(lockPath: string, sessionId: SessionId, request: OpenSessionRequest): Promise<void> {
		const lock: LockFile = {
			...this.#owner,
			sessionId,
			createdAt: this.#runtime.clock.now(),
		};
		const create = async (): Promise<void> => {
			const handle = await this.#fileSystem.open(lockPath, "wx", 0o600);
			try {
				await handle.write(`${JSON.stringify(lock)}\n`);
				await handle.sync();
			} finally {
				await handle.close();
			}
			await this.#fileSystem.setMode(lockPath, 0o600);
		};
		try {
			await create();
			return;
		} catch (error) {
			if (!isFileSystemError(error, "EEXIST")) throw error;
		}
		const existingText = new TextDecoder().decode(await this.#fileSystem.readFile(lockPath));
		const existing = parseLock(existingText);
		const status = await this.#processInspector.status(existing);
		if (status !== "dead") {
			throw new Error(`Session is locked by ${status} owner PID ${existing.pid}`);
		}
		if (request.mode === "print" && !request.forceUnlock) {
			throw new Error("A dead Session lock requires --force-unlock in print mode");
		}
		const archive = `${lockPath}.stale-${safeIdentity(String(this.#runtime.clock.now()))}`;
		await this.#fileSystem.rename(lockPath, archive);
		await create();
	}

	async #releaseLock(lockPath: string): Promise<void> {
		let text: string;
		try {
			text = new TextDecoder().decode(await this.#fileSystem.readFile(lockPath));
		} catch (error) {
			if (isFileSystemError(error, "ENOENT")) return;
			throw error;
		}
		const lock = parseLock(text);
		if (lock.token !== this.#owner.token)
			throw new Error("Refusing to remove a Session lock owned by another process");
		await this.#fileSystem.removeFile(lockPath);
	}
}
