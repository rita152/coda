import type { DiagnosticSink } from "@coda/tui";
import type { SessionMediaCodec } from "./media-codec.ts";
import {
	CURRENT_SESSION_FORMAT_VERSION,
	SESSION_RECORD_TYPES,
	type SessionFormatVersion,
	type SessionHeader,
	type SessionRecord,
	type SessionRecordType,
} from "./records.ts";
import type { SessionJournalStore } from "./session-journal-store.ts";
import { isSessionHeader, isSessionRecordEnvelope, isSessionRecordPayload } from "./session-schema.ts";

export interface ParsedSessionJournal {
	readonly header: SessionHeader;
	readonly records: readonly SessionRecord[];
	readonly sourceText: string;
}

type LegacySessionFormatVersion = Exclude<SessionFormatVersion, typeof CURRENT_SESSION_FORMAT_VERSION>;

interface SessionMigration {
	readonly to: SessionFormatVersion;
	migrate(records: readonly SessionRecord[], mediaCodec: SessionMediaCodec): Promise<readonly SessionRecord[]>;
}

const identityMigration = async (records: readonly SessionRecord[]): Promise<readonly SessionRecord[]> => records;

/** Every historical format has exactly one declared successor. */
const SESSION_MIGRATIONS = Object.freeze({
	1: {
		to: 2,
		migrate: async (records, mediaCodec) => {
			const encoded: SessionRecord[] = [];
			for (const record of records) encoded.push(await mediaCodec.encodeRecord(record));
			return encoded;
		},
	},
	2: { to: 3, migrate: identityMigration },
	3: { to: 4, migrate: identityMigration },
	4: { to: 5, migrate: identityMigration },
	5: { to: 6, migrate: identityMigration },
	6: { to: 7, migrate: identityMigration },
	7: { to: 8, migrate: identityMigration },
	8: { to: 9, migrate: identityMigration },
	9: { to: 10, migrate: identityMigration },
	10: { to: 11, migrate: identityMigration },
} satisfies Readonly<Record<LegacySessionFormatVersion, SessionMigration>>);

const RECORD_TYPES = new Set<string>(SESSION_RECORD_TYPES);

/** Parses, validates, and migrates versioned Session journals. */
export class SessionCodecRegistry {
	readonly #store: SessionJournalStore;
	readonly #diagnostics?: DiagnosticSink;

	constructor(options: { readonly store: SessionJournalStore; readonly diagnostics?: DiagnosticSink }) {
		this.#store = options.store;
		this.#diagnostics = options.diagnostics;
	}

	async read(path: string): Promise<ParsedSessionJournal> {
		return this.parse(await this.#store.readText(path), path);
	}

	async readCurrent(path: string, mediaCodec: SessionMediaCodec): Promise<ParsedSessionJournal> {
		const original = await this.read(path);
		if (original.header.version === CURRENT_SESSION_FORMAT_VERSION) return original;

		const fromVersion = original.header.version;
		let staged = original;
		const visited = new Set<SessionFormatVersion>();
		while (staged.header.version !== CURRENT_SESSION_FORMAT_VERSION) {
			if (visited.has(staged.header.version)) {
				throw new Error(`Session migration cycle detected at v${staged.header.version}`);
			}
			visited.add(staged.header.version);
			const migration = SESSION_MIGRATIONS[staged.header.version as LegacySessionFormatVersion];
			if (!migration) throw new Error(`No Session migration registered for v${staged.header.version}`);
			const records = await migration.migrate(staged.records, mediaCodec);
			const header: SessionHeader = { ...staged.header, version: migration.to };
			staged = this.parse(serializeJournal(header, records), path);
		}

		const backupPath = await this.#store.installMigration({
			path,
			sourceText: original.sourceText,
			migratedText: staged.sourceText,
			fromVersion,
			validate: (text, candidatePath) => {
				this.parse(text, candidatePath);
			},
		});
		await this.#diagnostics?.({
			code: "session.migrated",
			message: `Migrated a Session v${fromVersion} journal to Session v${CURRENT_SESSION_FORMAT_VERSION}`,
			details: { path, backupPath, fromVersion, toVersion: CURRENT_SESSION_FORMAT_VERSION },
		});
		return staged;
	}

	parse(text: string, path: string): ParsedSessionJournal {
		const complete = text.endsWith("\n");
		const lines = text.split("\n");
		if (complete) lines.pop();
		else {
			const truncated = lines.pop();
			if (truncated !== undefined) {
				void this.#diagnostics?.({
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
		if (!isSessionHeader(headerValue)) throw new Error("Unsupported or invalid Session header");
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
				throw new Error(`Session record ${index} violates the linear journal schema`);
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
}

function serializeJournal(header: SessionHeader, records: readonly SessionRecord[]): string {
	return `${[header, ...records].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}
