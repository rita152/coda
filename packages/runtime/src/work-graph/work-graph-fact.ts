import { type AgentInput, assertRunLimits, cloneFrozen } from "@coda/agent";
import type { JsonValue } from "@coda/ai";
import type {
	DesiredRuntimeConfiguration,
	PublicationOutcome,
	WorkDiagnostic,
	WorkExecutionMode,
	WorkGraphId,
	WorkItemId,
	WorkItemInputKind,
	WorkItemState,
	WorkRunEvidence,
	WorkRunResult,
	WorkspaceArtifact,
	WorkspacePlacementDescriptor,
} from "./types.ts";
import { assertWorkerFact, type WorkerFact } from "./worker-fact.ts";

export const WORK_GRAPH_FACT_VERSION = 1 as const;
export const MAXIMUM_WORK_GRAPH_IDENTITY_LENGTH = 256;

const MAXIMUM_DERIVED_IDENTITY_LENGTH = 1_024;
const MAXIMUM_TEXT_LENGTH = 65_536;
const MAXIMUM_DIAGNOSTIC_LENGTH = 4_096;
const MAXIMUM_REFERENCE_LENGTH = 8_192;
const MAXIMUM_IMAGE_DATA_LENGTH = 16 * 1_024 * 1_024;
const MAXIMUM_ARRAY_LENGTH = 1_024;
const MAXIMUM_JSON_DEPTH = 32;
const MAXIMUM_JSON_NODES = 16_384;
const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

interface WorkGraphFactBase {
	readonly version: typeof WORK_GRAPH_FACT_VERSION;
	readonly graphId: WorkGraphId;
	readonly timestamp: number;
}

export interface WorkGraphItemDefinition {
	readonly itemId: WorkItemId;
	readonly order: number;
	readonly parentItemId?: WorkItemId;
	readonly dependencies: readonly WorkItemId[];
	readonly objective: string;
	readonly executionMode: WorkExecutionMode;
	readonly desiredConfiguration: DesiredRuntimeConfiguration;
	readonly publicationOrder: number;
	readonly runtimeId: string;
	readonly sessionId: string;
	readonly placement: WorkspacePlacementDescriptor;
}

export type WorkGraphFact =
	| (WorkGraphFactBase & {
			readonly type: "graph_accepted";
			readonly batchId: string;
			readonly order: number;
			readonly objective: string;
			readonly maximumConcurrency: number;
			readonly root: WorkGraphItemDefinition;
	  })
	| (WorkGraphFactBase & {
			readonly type: "items_accepted";
			readonly batchId: string;
			readonly items: readonly WorkGraphItemDefinition[];
	  })
	| (WorkGraphFactBase & {
			readonly type: "input_accepted";
			readonly batchId: string;
			readonly deliveryId: string;
			readonly itemId: WorkItemId;
			readonly kind: WorkItemInputKind;
			readonly input: AgentInput;
			readonly resourceReferences: readonly string[];
	  })
	| (WorkGraphFactBase & {
			readonly type: "input_resources_settled";
			readonly deliveryId: string;
			readonly itemId: WorkItemId;
			readonly outcome: "committed" | "failed";
			readonly diagnostic?: string;
	  })
	| (WorkGraphFactBase & {
			readonly type: "item_configuration_changed";
			readonly batchId: string;
			readonly itemId: WorkItemId;
			readonly configuration: DesiredRuntimeConfiguration;
	  })
	| (WorkGraphFactBase & {
			readonly type: "item_transitioned";
			readonly itemId: WorkItemId;
			readonly from: WorkItemState;
			readonly to: WorkItemState;
	  })
	| (WorkGraphFactBase & {
			readonly type: "worker_fact_recorded";
			readonly itemId: WorkItemId;
			readonly runtimeId: string;
			readonly sessionId: string;
			readonly fact: WorkerFact;
	  })
	| (WorkGraphFactBase & {
			readonly type: "cancellation_requested";
			readonly batchId: string;
			readonly target: { readonly type: "graph" } | { readonly type: "item"; readonly itemId: WorkItemId };
	  })
	| (WorkGraphFactBase & {
			readonly type: "publication_started";
			readonly itemId: WorkItemId;
			readonly artifact: WorkspaceArtifact;
			readonly target?: WorkspacePlacementDescriptor;
	  })
	| (WorkGraphFactBase & {
			readonly type: "publication_settled";
			readonly itemId: WorkItemId;
			readonly artifact: WorkspaceArtifact;
			readonly publication: PublicationOutcome;
	  })
	| (WorkGraphFactBase & {
			readonly type: "ownership_released";
			readonly itemId: WorkItemId;
			readonly preservePlacement: boolean;
	  })
	| (WorkGraphFactBase & {
			readonly type: "recovery_interrupted";
			readonly itemId: WorkItemId;
			readonly from: WorkItemState;
			readonly reasons: readonly string[];
			readonly artifact?: WorkspaceArtifact;
	  })
	| (WorkGraphFactBase & {
			readonly type: "item_result_recorded";
			readonly itemId: WorkItemId;
			readonly state: Extract<WorkItemState, "succeeded" | "failed" | "canceled" | "interrupted" | "blocked">;
			readonly run?: WorkRunResult;
			readonly evidence?: WorkRunEvidence;
			readonly diagnostics: readonly WorkDiagnostic[];
			readonly blockedBy?: readonly WorkItemId[];
	  })
	| (WorkGraphFactBase & {
			readonly type: "graph_result_recorded";
			readonly effectiveConcurrency: number;
	  });

const FACT_KEYS = {
	graph_accepted: [
		"version",
		"type",
		"graphId",
		"timestamp",
		"batchId",
		"order",
		"objective",
		"maximumConcurrency",
		"root",
	],
	items_accepted: ["version", "type", "graphId", "timestamp", "batchId", "items"],
	input_accepted: [
		"version",
		"type",
		"graphId",
		"timestamp",
		"batchId",
		"deliveryId",
		"itemId",
		"kind",
		"input",
		"resourceReferences",
	],
	input_resources_settled: [
		"version",
		"type",
		"graphId",
		"timestamp",
		"deliveryId",
		"itemId",
		"outcome",
		"diagnostic",
	],
	item_configuration_changed: ["version", "type", "graphId", "timestamp", "batchId", "itemId", "configuration"],
	item_transitioned: ["version", "type", "graphId", "timestamp", "itemId", "from", "to"],
	worker_fact_recorded: ["version", "type", "graphId", "timestamp", "itemId", "runtimeId", "sessionId", "fact"],
	cancellation_requested: ["version", "type", "graphId", "timestamp", "batchId", "target"],
	publication_started: ["version", "type", "graphId", "timestamp", "itemId", "artifact", "target"],
	publication_settled: ["version", "type", "graphId", "timestamp", "itemId", "artifact", "publication"],
	ownership_released: ["version", "type", "graphId", "timestamp", "itemId", "preservePlacement"],
	recovery_interrupted: ["version", "type", "graphId", "timestamp", "itemId", "from", "reasons", "artifact"],
	item_result_recorded: [
		"version",
		"type",
		"graphId",
		"timestamp",
		"itemId",
		"state",
		"run",
		"evidence",
		"diagnostics",
		"blockedBy",
	],
	graph_result_recorded: ["version", "type", "graphId", "timestamp", "effectiveConcurrency"],
} as const satisfies Record<WorkGraphFact["type"], readonly string[]>;

const OPTIONAL_FACT_KEYS = {
	graph_accepted: [],
	items_accepted: [],
	input_accepted: [],
	input_resources_settled: ["diagnostic"],
	item_configuration_changed: [],
	item_transitioned: [],
	worker_fact_recorded: [],
	cancellation_requested: [],
	publication_started: ["target"],
	publication_settled: [],
	ownership_released: [],
	recovery_interrupted: ["artifact"],
	item_result_recorded: ["run", "evidence", "blockedBy"],
	graph_result_recorded: [],
} as const satisfies Record<WorkGraphFact["type"], readonly string[]>;

const ITEM_DEFINITION_KEYS = [
	"itemId",
	"order",
	"parentItemId",
	"dependencies",
	"objective",
	"executionMode",
	"desiredConfiguration",
	"publicationOrder",
	"runtimeId",
	"sessionId",
	"placement",
] as const;

const ITEM_STATES = [
	"pending",
	"ready",
	"preparing",
	"running",
	"settling",
	"succeeded",
	"failed",
	"canceled",
	"interrupted",
	"blocked",
] as const satisfies readonly WorkItemState[];

function isRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function invalid(type: string, diagnostic: string): never {
	throw new Error(`Invalid Work Graph Fact ${type}: ${diagnostic}`);
}

function assertExactKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
	type: string,
	optional: readonly string[] = [],
): void {
	const admitted = new Set(allowed);
	for (const key of Object.keys(value)) {
		if (!admitted.has(key)) invalid(type, `unexpected field ${key}`);
	}
	const omitted = new Set(optional);
	for (const key of allowed) {
		if (!omitted.has(key) && !(key in value)) invalid(type, `missing field ${key}`);
	}
}

function assertJsonCompatible(
	value: unknown,
	type: string,
	path = "fact",
	depth = 0,
	seen = new Set<object>(),
	budget = { nodes: 0 },
): void {
	budget.nodes++;
	if (budget.nodes > MAXIMUM_JSON_NODES) invalid(type, `${path} exceeds the JSON node limit`);
	if (depth > MAXIMUM_JSON_DEPTH) invalid(type, `${path} exceeds the JSON depth limit`);
	if (value === null || typeof value === "boolean") return;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) invalid(type, `${path} must contain only finite numbers`);
		return;
	}
	if (typeof value === "string") {
		if (value.length > MAXIMUM_IMAGE_DATA_LENGTH) invalid(type, `${path} contains an oversized string`);
		return;
	}
	if (typeof value !== "object") invalid(type, `${path} is not JSON-compatible`);
	if (seen.has(value)) invalid(type, `${path} contains a cycle`);
	seen.add(value);
	if (Array.isArray(value)) {
		if (value.length > MAXIMUM_ARRAY_LENGTH) invalid(type, `${path} exceeds the array length limit`);
		for (const [index, entry] of value.entries()) {
			assertJsonCompatible(entry, type, `${path}[${index}]`, depth + 1, seen, budget);
		}
	} else {
		if (!isRecord(value)) invalid(type, `${path} must contain only plain objects`);
		for (const [key, entry] of Object.entries(value)) {
			if (key.length === 0 || key.length > MAXIMUM_WORK_GRAPH_IDENTITY_LENGTH) {
				invalid(type, `${path} contains an invalid key`);
			}
			assertJsonCompatible(entry, type, `${path}.${key}`, depth + 1, seen, budget);
		}
	}
	seen.delete(value);
}

function assertIdentity(
	value: unknown,
	field: string,
	type: string,
	maximum = MAXIMUM_WORK_GRAPH_IDENTITY_LENGTH,
): void {
	if (typeof value !== "string" || value.length === 0 || value.length > maximum || !IDENTITY_PATTERN.test(value)) {
		invalid(type, `${field} must be a bounded opaque identity`);
	}
}

function assertText(value: unknown, field: string, type: string, maximum = MAXIMUM_TEXT_LENGTH): void {
	if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
		invalid(type, `${field} must be a non-empty string of at most ${maximum} characters`);
	}
}

function assertTimestamp(value: unknown, field: string, type: string): void {
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		invalid(type, `${field} must be a non-negative safe integer`);
	}
}

function assertPositiveInteger(value: unknown, field: string, type: string): void {
	if (!Number.isSafeInteger(value) || (value as number) < 1) {
		invalid(type, `${field} must be a positive safe integer`);
	}
}

function assertOneOf<T extends string>(
	value: unknown,
	field: string,
	type: string,
	options: readonly T[],
): asserts value is T {
	if (typeof value !== "string" || !options.includes(value as T)) {
		invalid(type, `${field} has an unsupported value`);
	}
}

function assertConfiguration(value: unknown, type: string): void {
	if (!isRecord(value)) invalid(type, "configuration must be an object");
	assertExactKeys(value, ["model", "reasoning", "runLimits"], type, ["runLimits"]);
	if (!isRecord(value.model)) invalid(type, "configuration.model must be an object");
	assertExactKeys(value.model, ["provider", "id"], type);
	assertText(value.model.provider, "configuration.model.provider", type, MAXIMUM_WORK_GRAPH_IDENTITY_LENGTH);
	assertText(value.model.id, "configuration.model.id", type, MAXIMUM_REFERENCE_LENGTH);
	assertOneOf(value.reasoning, "configuration.reasoning", type, [
		"off",
		"minimal",
		"low",
		"medium",
		"high",
		"xhigh",
		"max",
	]);
	if (value.runLimits !== undefined) {
		try {
			assertRunLimits(value.runLimits, "runLimits");
		} catch (error) {
			invalid(type, error instanceof Error ? error.message : String(error));
		}
	}
}

function assertPlacement(value: unknown, field: string, type: string): void {
	if (!isRecord(value)) invalid(type, `${field} must be an object`);
	assertExactKeys(
		value,
		["placementId", "root", "baseIdentity", "targetPlacementId", "targetIdentity", "kind"],
		type,
		["targetPlacementId", "targetIdentity"],
	);
	assertIdentity(value.placementId, `${field}.placementId`, type, MAXIMUM_DERIVED_IDENTITY_LENGTH);
	assertText(value.root, `${field}.root`, type, MAXIMUM_REFERENCE_LENGTH);
	assertText(value.baseIdentity, `${field}.baseIdentity`, type, MAXIMUM_REFERENCE_LENGTH);
	if (value.targetPlacementId !== undefined) {
		assertIdentity(value.targetPlacementId, `${field}.targetPlacementId`, type, MAXIMUM_DERIVED_IDENTITY_LENGTH);
	}
	if (value.targetIdentity !== undefined) {
		assertText(value.targetIdentity, `${field}.targetIdentity`, type, MAXIMUM_REFERENCE_LENGTH);
	}
	assertOneOf(value.kind, `${field}.kind`, type, ["direct", "git_worktree", "memory"]);
}

function assertArtifact(value: unknown, field: string, type: string): void {
	if (!isRecord(value)) invalid(type, `${field} must be an object`);
	assertExactKeys(value, ["artifactId", "placementId", "baseIdentity", "kind", "reference", "metadata"], type, [
		"reference",
		"metadata",
	]);
	assertIdentity(value.artifactId, `${field}.artifactId`, type, MAXIMUM_DERIVED_IDENTITY_LENGTH);
	assertIdentity(value.placementId, `${field}.placementId`, type, MAXIMUM_DERIVED_IDENTITY_LENGTH);
	assertText(value.baseIdentity, `${field}.baseIdentity`, type, MAXIMUM_REFERENCE_LENGTH);
	assertOneOf(value.kind, `${field}.kind`, type, ["none", "git_commit", "memory"]);
	if (value.reference !== undefined) assertText(value.reference, `${field}.reference`, type, MAXIMUM_REFERENCE_LENGTH);
	if (value.metadata !== undefined) assertJsonCompatible(value.metadata, type, `${field}.metadata`);
}

function assertPublication(value: unknown, type: string): void {
	if (!isRecord(value) || typeof value.state !== "string") invalid(type, "publication must be an object");
	if (value.state === "not_required") {
		assertExactKeys(value, ["state", "publicationId", "targetPlacementId", "targetIdentity"], type, [
			"publicationId",
			"targetPlacementId",
			"targetIdentity",
		]);
	} else if (value.state === "published") {
		assertExactKeys(value, ["state", "publicationId", "targetPlacementId", "targetIdentity"], type, [
			"publicationId",
			"targetPlacementId",
			"targetIdentity",
		]);
	} else if (value.state === "not_published") {
		assertExactKeys(value, ["state", "publicationId", "targetPlacementId", "reason", "diagnostic"], type, [
			"publicationId",
			"targetPlacementId",
			"diagnostic",
		]);
		assertOneOf(value.reason, "publication.reason", type, [
			"canceled",
			"conflict",
			"changed_source",
			"failed",
			"interrupted",
		]);
		if (value.diagnostic !== undefined) {
			assertText(value.diagnostic, "publication.diagnostic", type, MAXIMUM_DIAGNOSTIC_LENGTH);
		}
	} else invalid(type, "publication.state has an unsupported value");
	if (value.publicationId !== undefined) {
		assertIdentity(value.publicationId, "publication.publicationId", type, MAXIMUM_DERIVED_IDENTITY_LENGTH);
	}
	if (value.targetPlacementId !== undefined) {
		assertIdentity(value.targetPlacementId, "publication.targetPlacementId", type, MAXIMUM_DERIVED_IDENTITY_LENGTH);
	}
	if (value.targetIdentity !== undefined) {
		assertText(value.targetIdentity, "publication.targetIdentity", type, MAXIMUM_REFERENCE_LENGTH);
	}
}

function assertItemDefinition(value: unknown, type: string): void {
	if (!isRecord(value)) invalid(type, "Work Item definition must be an object");
	assertExactKeys(value, ITEM_DEFINITION_KEYS, type, ["parentItemId"]);
	assertIdentity(value.itemId, "item.itemId", type);
	assertTimestamp(value.order, "item.order", type);
	if (value.parentItemId !== undefined) assertIdentity(value.parentItemId, "item.parentItemId", type);
	if (!Array.isArray(value.dependencies) || value.dependencies.length > MAXIMUM_ARRAY_LENGTH) {
		invalid(type, "item.dependencies must be a bounded array");
	}
	for (const dependency of value.dependencies) assertIdentity(dependency, "item.dependencies[]", type);
	assertText(value.objective, "item.objective", type);
	assertOneOf(value.executionMode, "item.executionMode", type, ["read_only", "write"]);
	assertConfiguration(value.desiredConfiguration, type);
	assertTimestamp(value.publicationOrder, "item.publicationOrder", type);
	assertIdentity(value.runtimeId, "item.runtimeId", type, MAXIMUM_DERIVED_IDENTITY_LENGTH);
	assertIdentity(value.sessionId, "item.sessionId", type, MAXIMUM_DERIVED_IDENTITY_LENGTH);
	assertPlacement(value.placement, "item.placement", type);
}

function assertAgentInput(value: unknown, type: string): void {
	if (typeof value === "string") {
		if (value.length > MAXIMUM_TEXT_LENGTH) invalid(type, "input text is too large");
		return;
	}
	if (!Array.isArray(value) || value.length > MAXIMUM_ARRAY_LENGTH)
		invalid(type, "input must be text or a bounded array");
	for (const [index, entry] of value.entries()) {
		if (!isRecord(entry) || typeof entry.type !== "string") invalid(type, `input[${index}] must be an object`);
		switch (entry.type) {
			case "text":
				assertExactKeys(entry, ["type", "text", "textSignature"], type, ["textSignature"]);
				if (typeof entry.text !== "string" || entry.text.length > MAXIMUM_TEXT_LENGTH) {
					invalid(type, `input[${index}].text is invalid`);
				}
				if (entry.textSignature !== undefined) {
					assertText(entry.textSignature, `input[${index}].textSignature`, type, MAXIMUM_REFERENCE_LENGTH);
				}
				break;
			case "image":
				assertExactKeys(entry, ["type", "data", "mimeType"], type);
				if (
					typeof entry.data !== "string" ||
					entry.data.length === 0 ||
					entry.data.length > MAXIMUM_IMAGE_DATA_LENGTH
				) {
					invalid(type, `input[${index}].data is invalid`);
				}
				assertText(entry.mimeType, `input[${index}].mimeType`, type, 256);
				break;
			case "skill":
				assertExactKeys(entry, ["type", "name", "path"], type);
				assertText(entry.name, `input[${index}].name`, type, MAXIMUM_WORK_GRAPH_IDENTITY_LENGTH);
				assertText(entry.path, `input[${index}].path`, type, MAXIMUM_REFERENCE_LENGTH);
				break;
			default:
				invalid(type, `input[${index}].type has an unsupported value`);
		}
	}
}

function assertExhaustion(value: unknown, field: string, type: string): void {
	if (!isRecord(value)) invalid(type, `${field} must be an object`);
	assertExactKeys(value, ["limit", "maximum", "observed"], type);
	assertOneOf(value.limit, `${field}.limit`, type, [
		"turns",
		"model_attempts",
		"tool_invocations",
		"elapsed_ms",
		"total_tokens",
		"total_cost_usd",
		"consecutive_equivalent_tool_batches",
	]);
	for (const key of ["maximum", "observed"] as const) {
		if (typeof value[key] !== "number" || !Number.isFinite(value[key]) || value[key] < 0) {
			invalid(type, `${field}.${key} must be a non-negative finite number`);
		}
	}
}

function assertRunFailure(value: unknown, type: string): void {
	if (!isRecord(value) || typeof value.kind !== "string") invalid(type, "run.failure must be an object");
	if (value.kind === "budget") {
		assertExactKeys(value, ["kind", "message", "exhaustion"], type);
		assertExhaustion(value.exhaustion, "run.failure.exhaustion", type);
	} else {
		assertExactKeys(value, ["kind", "message"], type);
		assertOneOf(value.kind, "run.failure.kind", type, ["model", "tool", "runtime", "listener"]);
	}
	assertText(value.message, "run.failure.message", type, MAXIMUM_DIAGNOSTIC_LENGTH);
}

function assertRunResult(value: unknown, type: string): void {
	if (!isRecord(value)) invalid(type, "run must be an object");
	assertExactKeys(value, ["runId", "outcome", "failure", "assistantText"], type, ["failure", "assistantText"]);
	assertIdentity(value.runId, "run.runId", type, MAXIMUM_DERIVED_IDENTITY_LENGTH);
	assertOneOf(value.outcome, "run.outcome", type, ["success", "error", "aborted"]);
	if (value.failure !== undefined) assertRunFailure(value.failure, type);
	if (value.assistantText !== undefined && typeof value.assistantText !== "string") {
		invalid(type, "run.assistantText must be a string");
	}
}

function assertEvidence(value: unknown, type: string): void {
	if (!isRecord(value)) invalid(type, "evidence must be an object");
	assertExactKeys(value, ["version", "facts"], type);
	assertPositiveInteger(value.version, "evidence.version", type);
	assertJsonCompatible(value.facts, type, "evidence.facts");
}

function assertDiagnostic(value: unknown, type: string): void {
	if (!isRecord(value)) invalid(type, "diagnostic must be an object");
	assertExactKeys(value, ["code", "message", "details"], type, ["details"]);
	assertIdentity(value.code, "diagnostic.code", type);
	assertText(value.message, "diagnostic.message", type, MAXIMUM_DIAGNOSTIC_LENGTH);
	if (value.details !== undefined) assertJsonCompatible(value.details, type, "diagnostic.details");
}

/** Fully validates the closed algebra, including exact nested keys and bounded identities. */
export function assertWorkGraphFact(value: unknown): asserts value is WorkGraphFact {
	const discriminator = isRecord(value) && typeof value.type === "string" ? value.type : "unknown";
	assertJsonCompatible(value, discriminator);
	if (!isRecord(value) || typeof value.type !== "string" || !(value.type in FACT_KEYS)) {
		invalid("unknown", "unsupported fact type");
	}
	const type = value.type as WorkGraphFact["type"];
	assertExactKeys(value, FACT_KEYS[type], type, OPTIONAL_FACT_KEYS[type]);
	if (value.version !== WORK_GRAPH_FACT_VERSION) invalid(type, `version must be ${WORK_GRAPH_FACT_VERSION}`);
	assertIdentity(value.graphId, "graphId", type);
	assertTimestamp(value.timestamp, "timestamp", type);

	switch (type) {
		case "graph_accepted":
			assertIdentity(value.batchId, "batchId", type);
			assertTimestamp(value.order, "order", type);
			assertText(value.objective, "objective", type);
			assertPositiveInteger(value.maximumConcurrency, "maximumConcurrency", type);
			assertItemDefinition(value.root, type);
			return;
		case "items_accepted":
			assertIdentity(value.batchId, "batchId", type);
			if (!Array.isArray(value.items) || value.items.length === 0 || value.items.length > MAXIMUM_ARRAY_LENGTH) {
				invalid(type, "items must be a non-empty bounded array");
			}
			for (const item of value.items) assertItemDefinition(item, type);
			return;
		case "input_accepted":
			assertIdentity(value.batchId, "batchId", type);
			assertIdentity(value.deliveryId, "deliveryId", type, MAXIMUM_DERIVED_IDENTITY_LENGTH);
			assertIdentity(value.itemId, "itemId", type);
			assertOneOf(value.kind, "kind", type, ["prompt", "steering", "follow_up"]);
			assertAgentInput(value.input, type);
			if (!Array.isArray(value.resourceReferences) || value.resourceReferences.length > MAXIMUM_ARRAY_LENGTH) {
				invalid(type, "resourceReferences must be a bounded array");
			}
			for (const reference of value.resourceReferences) {
				assertText(reference, "resourceReferences[]", type, MAXIMUM_REFERENCE_LENGTH);
			}
			return;
		case "input_resources_settled":
			assertIdentity(value.deliveryId, "deliveryId", type, MAXIMUM_DERIVED_IDENTITY_LENGTH);
			assertIdentity(value.itemId, "itemId", type);
			assertOneOf(value.outcome, "outcome", type, ["committed", "failed"]);
			if (value.outcome === "failed" && value.diagnostic === undefined) {
				invalid(type, "failed settlement requires diagnostic");
			}
			if (value.outcome === "committed" && value.diagnostic !== undefined) {
				invalid(type, "committed settlement cannot carry diagnostic");
			}
			if (value.diagnostic !== undefined) {
				assertText(value.diagnostic, "diagnostic", type, MAXIMUM_DIAGNOSTIC_LENGTH);
			}
			return;
		case "item_configuration_changed":
			assertIdentity(value.batchId, "batchId", type);
			assertIdentity(value.itemId, "itemId", type);
			assertConfiguration(value.configuration, type);
			return;
		case "item_transitioned":
			assertIdentity(value.itemId, "itemId", type);
			assertOneOf(value.from, "from", type, ITEM_STATES);
			assertOneOf(value.to, "to", type, ITEM_STATES);
			if (value.from === value.to) invalid(type, "from and to must differ");
			return;
		case "worker_fact_recorded":
			assertIdentity(value.itemId, "itemId", type);
			assertIdentity(value.runtimeId, "runtimeId", type, MAXIMUM_DERIVED_IDENTITY_LENGTH);
			assertIdentity(value.sessionId, "sessionId", type, MAXIMUM_DERIVED_IDENTITY_LENGTH);
			assertWorkerFact(value.fact);
			if ((value.fact as WorkerFact).timestamp !== value.timestamp) {
				invalid(type, "wrapper timestamp must equal Worker Fact timestamp");
			}
			return;
		case "cancellation_requested":
			assertIdentity(value.batchId, "batchId", type);
			if (!isRecord(value.target) || typeof value.target.type !== "string") {
				invalid(type, "target must be an object");
			}
			if (value.target.type === "graph") assertExactKeys(value.target, ["type"], type);
			else if (value.target.type === "item") {
				assertExactKeys(value.target, ["type", "itemId"], type);
				assertIdentity(value.target.itemId, "target.itemId", type);
			} else invalid(type, "target.type has an unsupported value");
			return;
		case "publication_started":
			assertIdentity(value.itemId, "itemId", type);
			assertArtifact(value.artifact, "artifact", type);
			if (value.target !== undefined) assertPlacement(value.target, "target", type);
			return;
		case "publication_settled":
			assertIdentity(value.itemId, "itemId", type);
			assertArtifact(value.artifact, "artifact", type);
			assertPublication(value.publication, type);
			return;
		case "ownership_released":
			assertIdentity(value.itemId, "itemId", type);
			if (typeof value.preservePlacement !== "boolean") invalid(type, "preservePlacement must be boolean");
			return;
		case "recovery_interrupted":
			assertIdentity(value.itemId, "itemId", type);
			assertOneOf(value.from, "from", type, ITEM_STATES);
			if (!Array.isArray(value.reasons) || value.reasons.length === 0 || value.reasons.length > 64) {
				invalid(type, "reasons must be a non-empty bounded array");
			}
			for (const reason of value.reasons) assertText(reason, "reasons[]", type, MAXIMUM_DIAGNOSTIC_LENGTH);
			if (value.artifact !== undefined) assertArtifact(value.artifact, "artifact", type);
			return;
		case "item_result_recorded":
			assertIdentity(value.itemId, "itemId", type);
			assertOneOf(value.state, "state", type, ["succeeded", "failed", "canceled", "interrupted", "blocked"]);
			if (value.run !== undefined) assertRunResult(value.run, type);
			if (value.evidence !== undefined) assertEvidence(value.evidence, type);
			if (!Array.isArray(value.diagnostics) || value.diagnostics.length > MAXIMUM_ARRAY_LENGTH) {
				invalid(type, "diagnostics must be a bounded array");
			}
			for (const diagnostic of value.diagnostics) assertDiagnostic(diagnostic, type);
			if (value.blockedBy !== undefined) {
				if (!Array.isArray(value.blockedBy) || value.blockedBy.length === 0) {
					invalid(type, "blockedBy must be a non-empty array when present");
				}
				for (const blockedBy of value.blockedBy) assertIdentity(blockedBy, "blockedBy[]", type);
			}
			if (value.state === "blocked" && value.blockedBy === undefined) {
				invalid(type, "blocked result requires blockedBy");
			}
			if (value.state !== "blocked" && value.blockedBy !== undefined) {
				invalid(type, "only blocked results may carry blockedBy");
			}
			return;
		case "graph_result_recorded":
			assertTimestamp(value.effectiveConcurrency, "effectiveConcurrency", type);
			return;
	}
	const exhaustive: never = type;
	return exhaustive;
}

function immutableFact(value: WorkGraphFact): WorkGraphFact {
	return cloneFrozen(value);
}

/** Runtime-owned semantic codec; byte framing remains a host Adapter concern. */
export const WorkGraphFactCodec = Object.freeze({
	encode(fact: WorkGraphFact): JsonValue {
		assertWorkGraphFact(fact);
		return immutableFact(fact) as unknown as JsonValue;
	},
	decode(value: unknown): WorkGraphFact {
		assertWorkGraphFact(value);
		return immutableFact(value);
	},
});
