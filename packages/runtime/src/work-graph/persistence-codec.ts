import type {
	WorkGraphRecord,
	WorkspaceGraphIndexEntry,
	WorkspaceLedgerRestore,
	WorkspaceSessionOwner,
	WorkspaceTargetIdentity,
} from "./ports.ts";
import { assertWorkerFact } from "./worker-fact.ts";

const RECORD_TYPES = new Set<WorkGraphRecord["type"]>([
	"batch_accepted",
	"input_resources_settled",
	"item_transition",
	"worker_fact",
	"item_result",
	"graph_result",
	"cancellation_requested",
	"publication",
	"ownership_released",
	"recovery_interrupted",
]);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

export interface WorkGraphEnvelope {
	readonly version: 1;
	readonly sequence: number;
	readonly record: WorkGraphRecord;
}

interface EncodedWorkspaceLedger {
	readonly version: 1;
	readonly activeGraphs: readonly WorkspaceGraphIndexEntry[];
	readonly nextGraphOrder: number;
	readonly nextPublicationOrder: number;
	readonly sessionOwners: readonly WorkspaceSessionOwner[];
	readonly targetIdentities: readonly WorkspaceTargetIdentity[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function identity(value: unknown, label: string): string {
	if (typeof value !== "string" || !ID_PATTERN.test(value)) {
		throw new Error(`Invalid ${label} identity: ${String(value)}`);
	}
	return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw new Error(`${label} must be a non-negative safe integer`);
	}
	return value as number;
}

function assertWorkGraphRecord(value: unknown): asserts value is WorkGraphRecord {
	if (!isRecord(value) || typeof value.type !== "string" || !RECORD_TYPES.has(value.type as WorkGraphRecord["type"])) {
		throw new Error("Invalid Work Graph record");
	}
	if (value.type !== "batch_accepted") identity(value.graphId, "Work Graph");
	if ("itemId" in value && value.itemId !== undefined) identity(value.itemId, "Work Item");
	if (value.type === "worker_fact") {
		identity(value.runtimeId, "Worker Runtime");
		identity(value.sessionId, "Session");
		assertWorkerFact(value.fact);
	}
}

export function encodeWorkGraphEnvelope(record: WorkGraphRecord, sequence: number): string {
	assertWorkGraphRecord(record);
	nonNegativeInteger(sequence, "Work Graph sequence");
	if (sequence === 0) throw new Error("Work Graph sequence must start at one");
	return JSON.stringify({ version: 1, sequence, record } satisfies WorkGraphEnvelope);
}

export function decodeWorkGraphEnvelope(line: string, expectedSequence: number): WorkGraphEnvelope {
	const value: unknown = JSON.parse(line);
	if (!isRecord(value) || value.version !== 1 || value.sequence !== expectedSequence) {
		throw new Error(`Invalid Work Graph record envelope at sequence ${expectedSequence}`);
	}
	assertWorkGraphRecord(value.record);
	return value as unknown as WorkGraphEnvelope;
}

export function emptyWorkspaceLedger(): WorkspaceLedgerRestore {
	return Object.freeze({
		activeGraphs: Object.freeze([]),
		nextGraphOrder: 0,
		nextPublicationOrder: 0,
		sessionOwners: Object.freeze([]),
		targetIdentities: Object.freeze([]),
		diagnostics: Object.freeze([]),
	});
}

export function encodeWorkspaceLedger(state: WorkspaceLedgerRestore): string {
	const encoded: EncodedWorkspaceLedger = {
		version: 1,
		activeGraphs: state.activeGraphs,
		nextGraphOrder: state.nextGraphOrder,
		nextPublicationOrder: state.nextPublicationOrder,
		sessionOwners: state.sessionOwners,
		targetIdentities: state.targetIdentities,
	};
	decodeWorkspaceLedger(JSON.stringify(encoded));
	return JSON.stringify(encoded);
}

export function decodeWorkspaceLedger(source: string): WorkspaceLedgerRestore {
	const value: unknown = JSON.parse(source);
	if (
		!isRecord(value) ||
		value.version !== 1 ||
		!Array.isArray(value.activeGraphs) ||
		!Array.isArray(value.sessionOwners) ||
		!Array.isArray(value.targetIdentities)
	) {
		throw new Error("Invalid Workspace Ledger");
	}
	const activeGraphs = value.activeGraphs.map((entry) => {
		if (!isRecord(entry)) throw new Error("Invalid Workspace Ledger Graph entry");
		return {
			graphId: identity(entry.graphId, "Work Graph") as WorkspaceGraphIndexEntry["graphId"],
			order: nonNegativeInteger(entry.order, "Work Graph order"),
		};
	});
	const sessionOwners = value.sessionOwners.map((entry) => {
		if (!isRecord(entry)) throw new Error("Invalid Workspace Ledger Session owner");
		return {
			sessionId: identity(entry.sessionId, "Session"),
			graphId: identity(entry.graphId, "Work Graph") as WorkspaceSessionOwner["graphId"],
			itemId: identity(entry.itemId, "Work Item") as WorkspaceSessionOwner["itemId"],
		};
	});
	const targetIdentities = value.targetIdentities.map((entry) => {
		if (!isRecord(entry)) throw new Error("Invalid Workspace Ledger target identity");
		if (typeof entry.targetPlacementId !== "string" || entry.targetPlacementId.length === 0) {
			throw new Error("Invalid Workspace Ledger target Placement identity");
		}
		if (typeof entry.targetIdentity !== "string" || entry.targetIdentity.length === 0) {
			throw new Error("Invalid Workspace Ledger target fingerprint");
		}
		return { targetPlacementId: entry.targetPlacementId, targetIdentity: entry.targetIdentity };
	});
	const activeIds = new Set(activeGraphs.map(({ graphId }) => graphId));
	if (activeIds.size !== activeGraphs.length) throw new Error("Duplicate active Work Graph in Workspace Ledger");
	const sessionIds = new Set(sessionOwners.map(({ sessionId }) => sessionId));
	if (sessionIds.size !== sessionOwners.length) throw new Error("Duplicate Session owner in Workspace Ledger");
	for (const owner of sessionOwners) {
		if (!activeIds.has(owner.graphId)) {
			throw new Error(`Session owner references inactive Work Graph: ${owner.graphId}`);
		}
	}
	return Object.freeze({
		activeGraphs: Object.freeze(activeGraphs),
		nextGraphOrder: nonNegativeInteger(value.nextGraphOrder, "next Work Graph order"),
		nextPublicationOrder: nonNegativeInteger(value.nextPublicationOrder, "next Publication order"),
		sessionOwners: Object.freeze(sessionOwners),
		targetIdentities: Object.freeze(targetIdentities),
		diagnostics: Object.freeze([]),
	});
}
