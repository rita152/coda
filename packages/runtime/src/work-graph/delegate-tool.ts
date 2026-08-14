import type { AgentTool, RunLimits, ToolExecutionContext, ToolExecutionOutput } from "@coda/agent";
import type { ThinkingLevel } from "@coda/ai";
import { Type } from "@coda/ai";
import type { WorkExecutionMode, WorkResult } from "./types.ts";

const MAXIMUM_DELEGATED_ITEMS = 8;
const MAXIMUM_MODEL_RESULT_TEXT = 4_096;
const MAXIMUM_MODEL_DIAGNOSTICS = 8;

const RunLimitsSchema = Type.Object(
	{
		maxTurns: Type.Optional(Type.Integer({ minimum: 1 })),
		maxModelAttempts: Type.Optional(Type.Integer({ minimum: 1 })),
		maxToolInvocations: Type.Optional(Type.Integer({ minimum: 1 })),
		maxElapsedMs: Type.Optional(Type.Integer({ minimum: 1 })),
		maxTotalTokens: Type.Optional(Type.Integer({ minimum: 1 })),
		maxTotalCostUsd: Type.Optional(Type.Number({ minimum: 0 })),
		maxConsecutiveEquivalentToolBatches: Type.Optional(Type.Integer({ minimum: 1 })),
	},
	{ additionalProperties: false },
);

const ConfigurationSchema = Type.Object(
	{
		model: Type.Object(
			{
				provider: Type.String({ minLength: 1, maxLength: 256 }),
				id: Type.String({ minLength: 1, maxLength: 256 }),
			},
			{ additionalProperties: false },
		),
		reasoning: Type.Union(
			["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((value) => Type.Literal(value)),
		),
		runLimits: Type.Optional(RunLimitsSchema),
	},
	{ additionalProperties: false },
);

const DelegateParameters = Type.Object(
	{
		items: Type.Array(
			Type.Object(
				{
					itemId: Type.String({ minLength: 1, maxLength: 256 }),
					objective: Type.String({ minLength: 1, maxLength: 65_536 }),
					executionMode: Type.Union([Type.Literal("read_only"), Type.Literal("write")]),
					dependencies: Type.Optional(
						Type.Array(Type.String({ minLength: 1, maxLength: 256 }), {
							maxItems: MAXIMUM_DELEGATED_ITEMS,
						}),
					),
					configuration: Type.Optional(ConfigurationSchema),
				},
				{ additionalProperties: false },
			),
			{ minItems: 1, maxItems: MAXIMUM_DELEGATED_ITEMS },
		),
	},
	{ additionalProperties: false },
);

export interface DelegateChildSpecification {
	readonly itemId: string;
	readonly objective: string;
	readonly executionMode: WorkExecutionMode;
	readonly dependencies?: readonly string[];
	readonly configuration?: {
		readonly model: { readonly provider: string; readonly id: string };
		readonly reasoning: ThinkingLevel | "off";
		readonly runLimits?: RunLimits;
	};
}

interface DelegateToolDetails {
	readonly results: readonly ReturnType<typeof projectResult>[];
}

function truncate(value: string, maximum: number): string {
	return value.length <= maximum ? value : `${value.slice(0, maximum)}…`;
}

function projectResult(result: WorkResult) {
	return Object.freeze({
		itemId: String(result.itemId),
		...(result.parentItemId ? { parentItemId: String(result.parentItemId) } : {}),
		state: result.state,
		...(result.run
			? {
					run: Object.freeze({
						outcome: result.run.outcome,
						...(result.run.failure
							? {
									failure: {
										kind: result.run.failure.kind,
										message: truncate(result.run.failure.message, 1_024),
									},
								}
							: {}),
						...(result.run.assistantText
							? { assistantText: truncate(result.run.assistantText, MAXIMUM_MODEL_RESULT_TEXT) }
							: {}),
					}),
				}
			: {}),
		publication: result.publication,
		diagnostics: Object.freeze(
			result.diagnostics
				.slice(0, MAXIMUM_MODEL_DIAGNOSTICS)
				.map(({ code, message }) => Object.freeze({ code, message: truncate(message, 1_024) })),
		),
		...(result.blockedBy ? { blockedBy: result.blockedBy.map(String) } : {}),
	});
}

export function createDelegateTool(options: {
	readonly execute: (
		items: readonly DelegateChildSpecification[],
		context: ToolExecutionContext,
	) => Promise<readonly WorkResult[]>;
}): AgentTool<typeof DelegateParameters, DelegateToolDetails> {
	const tool: AgentTool<typeof DelegateParameters, DelegateToolDetails> = {
		name: "delegate",
		description:
			"Add a bounded batch of child Work Items under this Work Item, wait for their structured results, and continue. Graph, Runtime, and Session identities are bound by the coordinator and cannot be supplied.",
		parameters: DelegateParameters,
		replaySafety: "never",
		parallelSafe: false,
		execute: async (arguments_, context): Promise<ToolExecutionOutput<DelegateToolDetails>> => {
			context.signal.throwIfAborted();
			const results = await options.execute(arguments_.items as readonly DelegateChildSpecification[], context);
			context.signal.throwIfAborted();
			const projected = Object.freeze(results.map(projectResult));
			return {
				content: JSON.stringify({ results: projected }),
				observation: {
					status: "ok",
					truncated: results.some(
						(result) =>
							(result.run?.assistantText?.length ?? 0) > MAXIMUM_MODEL_RESULT_TEXT ||
							result.diagnostics.length > MAXIMUM_MODEL_DIAGNOSTICS,
					),
					facts: {
						itemCount: results.length,
						states: results.map(({ itemId, state }) => ({ itemId: String(itemId), state })),
					},
				},
				details: { results: projected },
			};
		},
	};
	return Object.freeze(tool);
}
