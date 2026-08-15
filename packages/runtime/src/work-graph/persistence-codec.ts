import type {
	WorkspaceGraphIndexEntry,
	WorkspaceLedgerRestore,
	WorkspaceSessionOwner,
	WorkspaceTargetIdentity,
} from "./ports.ts";
import { type WorkGraphFact, WorkGraphFactCodec } from "./work-graph-fact.ts";

/**
 * Runtime owns the Work Graph fact algebra and its line format. Physical persistence
 * adapters only store opaque restores/commits produced by this module.
 */

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

export interface WorkGraphEnvelope {
	readonly version: 1;
	readonly sequence: number;
	readonly graphId: string;
	readonly commit: unknown;
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

function facts(value: unknown): readonly WorkGraphFact[] {
	if (!Array.isArray(value) || value.length === 0) throw new Error("A Work Graph segment must contain Facts");
	const decoded = value.map((fact) => WorkGraphFactCodec.decode(fact));
	const graphId = decoded[0]!.graphId;
	if (decoded.some((fact) => fact.graphId !== graphId)) {
		throw new Error("A Work Graph segment cannot span Graph identities");
	}
	return Object.freeze(decoded);
}

export function encodeWorkGraphEnvelope(commit: unknown, sequence: number): string {
	nonNegativeInteger(sequence, "Work Graph sequence");
	if (sequence === 0) throw new Error("Work Graph sequence must start at one");
	const durable = facts(commit);
	return JSON.stringify({ version: 1, sequence, facts: durable });
}

export function decodeWorkGraphEnvelope(line: string, expectedSequence: number): WorkGraphEnvelope {
	const value: unknown = JSON.parse(line);
	if (!isRecord(value) || value.version !== 1 || value.sequence !== expectedSequence) {
		throw new Error(`Invalid Work Graph record envelope at sequence ${expectedSequence}`);
	}
	const commit = facts(value.facts);
	return Object.freeze({
		version: 1,
		sequence: expectedSequence,
		graphId: String(commit[0]!.graphId),
		commit,
	});
}

/** Combines opaque line commits into the opaque replay value returned by WorkGraphStore.load(). */
export function mergeWorkGraphCommits(commits: readonly unknown[]): unknown {
	return Object.freeze(commits.flatMap((commit) => facts(commit)));
}

/** Internal bridge from the opaque persistence protocol to the runtime fact algebra. */
export function decodeWorkGraphRestore(restore: unknown): readonly WorkGraphFact[] {
	if (!Array.isArray(restore)) throw new Error("Invalid Work Graph restore");
	if (restore.length === 0) return Object.freeze([]);
	return facts(restore);
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
