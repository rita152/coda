export {
	CodingCompletionController,
	type CodingCompletionControllerOptions,
	DEFAULT_COMPLETION_REPAIR_ATTEMPTS,
} from "./completion-controller.ts";
export { CompletionActivityProjection, classifyShellCommand } from "./completion-evidence.ts";
export { assessCompletion, CodingCompletionGate } from "./completion-gate.ts";
export { completionActivityFromRunEvidence } from "./run-evidence-adapter.ts";
export {
	COMPLETION_DISPOSITION_SCHEMA_VERSION,
	type CompletionActivitySnapshot,
	type CompletionDisposition,
	type CompletionDispositionStatus,
	type CompletionEvidenceCompleteness,
	type CompletionGateDecision,
	type CompletionGateInput,
	type CompletionModelTermination,
	type CompletionRunEvidence,
	type CompletionTemporalSnapshot,
	type CompletionVerificationResult,
	type CompletionWorkspaceEvidenceProvider,
	type WorkspaceEvidenceSnapshot,
} from "./types.ts";
export { createGitWorkspaceEvidenceProvider } from "./workspace-evidence.ts";
