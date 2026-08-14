export type { MemoryWorkspacePersistenceSeed } from "./work-graph/memory-workspace-persistence.ts";
export { MemoryWorkspacePersistence } from "./work-graph/memory-workspace-persistence.ts";
export type { WorkGraphEnvelope } from "./work-graph/persistence-codec.ts";
export {
	decodeWorkGraphEnvelope,
	decodeWorkspaceLedger,
	emptyWorkspaceLedger,
	encodeWorkGraphEnvelope,
	encodeWorkspaceLedger,
} from "./work-graph/persistence-codec.ts";
export type {
	WorkGraphStore,
	WorkGraphStoreRestore,
	WorkspaceGraphIndexEntry,
	WorkspaceLedger,
	WorkspaceLedgerAcceptance,
	WorkspaceLedgerRestore,
	WorkspacePersistence,
	WorkspacePersistenceLease,
	WorkspaceSessionOwner,
	WorkspaceTargetIdentity,
} from "./work-graph/ports.ts";
export type { WorkGraphFact } from "./work-graph/work-graph-fact.ts";
