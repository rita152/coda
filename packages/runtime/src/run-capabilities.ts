import type { AgentTool, ToolExecutionContext, ToolExecutionOutput } from "@coda/agent";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	AuthResult,
	Context,
	Model,
	ModelsSimpleStreamOptions,
	ThinkingLevel,
} from "@coda/ai";
import {
	buildSystemPrompt,
	type SystemPromptSnapshot,
	type TrustedProjectInstructions,
} from "./prompt/prompt-builder.ts";
import type { WorkExecutionMode, WorkspacePlacementDescriptor } from "./work-graph/types.ts";

export type RunToolEffect = "read" | "write" | "unknown";

export interface RunToolContribution {
	readonly tool: AgentTool;
	readonly effect: RunToolEffect;
	/** Reuse an already retained Workspace lease, such as control of a running background Process. */
	readonly leaseIdentity?: (arguments_: unknown) => string | undefined;
	readonly retainLease?: (
		output: ToolExecutionOutput,
		context: ToolExecutionContext,
	) => { readonly identity: string; readonly settled: Promise<void> } | undefined;
}

export interface RunModelSelection {
	readonly model: Model<Api>;
	readonly reasoning: ThinkingLevel | "off";
	readonly authSnapshot?: AuthResult;
}

export interface ModelDriverLease {
	readonly model: Model<Api>;
	readonly revision: string;
	stream(
		context: Context,
		options?: Omit<ModelsSimpleStreamOptions, "authSnapshot" | "reasoning">,
	): AssistantMessageEventStream;
	complete(
		context: Context,
		options?: Omit<ModelsSimpleStreamOptions, "authSnapshot" | "reasoning">,
	): Promise<AssistantMessage>;
	dispose(): Promise<void> | void;
}

export interface ModelDriverSource {
	acquire(selection: RunModelSelection, signal: AbortSignal): ModelDriverLease | Promise<ModelDriverLease>;
}

export interface RunCapabilityRevisionDescriptor {
	readonly source: string;
	readonly revision: string;
}

export interface RunPromptFragment {
	readonly id: string;
	readonly text: string;
}

export interface RunCapabilityContributionLease {
	readonly revision: string;
	readonly tools: readonly RunToolContribution[];
	readonly promptFragments: readonly RunPromptFragment[];
	dispose(): Promise<void> | void;
}

export interface RunCapabilitySource {
	readonly id: string;
	acquire(context: {
		readonly model: Model<Api>;
		readonly signal: AbortSignal;
	}): RunCapabilityContributionLease | Promise<RunCapabilityContributionLease>;
}

export interface RunCapabilityLease {
	readonly model: ModelDriverLease;
	readonly tools: readonly AgentTool[];
	readonly prompt: SystemPromptSnapshot;
	readonly revisions: readonly RunCapabilityRevisionDescriptor[];
	dispose(): Promise<void>;
}

export interface RunCapabilityAcquireContext {
	readonly selection: RunModelSelection;
	readonly placement: WorkspacePlacementDescriptor;
	readonly mode: WorkExecutionMode;
	readonly baseTools: readonly RunToolContribution[];
	readonly bindTools: (contributions: readonly RunToolContribution[]) => readonly AgentTool[];
	readonly signal: AbortSignal;
	readonly deadline?: number;
}

export interface RunCapabilityHost {
	acquire(context: RunCapabilityAcquireContext): Promise<RunCapabilityLease>;
}

export interface CreateRunCapabilityHostOptions {
	readonly model: ModelDriverSource;
	readonly contributors: readonly RunCapabilitySource[];
	readonly now: () => number;
	readonly platform: NodeJS.Platform;
	readonly interactionMode: "interactive" | "print" | "evaluation";
	readonly projectInstructions?: (
		placement: WorkspacePlacementDescriptor,
	) => TrustedProjectInstructions | undefined | Promise<TrustedProjectInstructions | undefined>;
	readonly systemPrompt?: SystemPromptSnapshot;
}

function aborted(signal: AbortSignal): unknown {
	return signal.reason ?? new DOMException("Run capability acquisition was canceled", "AbortError");
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function awaitCapability<T>(
	operation: T | PromiseLike<T>,
	signal: AbortSignal,
	deadline: number | undefined,
	now: () => number,
): Promise<T> {
	if (signal.aborted) return Promise.reject(aborted(signal));
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (settle: () => void): void => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			if (timer) clearTimeout(timer);
			settle();
		};
		const onAbort = (): void => finish(() => reject(aborted(signal)));
		signal.addEventListener("abort", onAbort, { once: true });
		if (deadline !== undefined) {
			timer = setTimeout(
				() => finish(() => reject(new Error("Run capability acquisition deadline exceeded"))),
				Math.max(0, deadline - now()),
			);
		}
		Promise.resolve(operation).then(
			(value) => finish(() => resolve(value)),
			(error: unknown) => finish(() => reject(error)),
		);
	});
}

async function awaitResource<T extends { dispose(): Promise<void> | void }>(
	operation: T | PromiseLike<T>,
	signal: AbortSignal,
	deadline: number | undefined,
	now: () => number,
): Promise<T> {
	const pending = Promise.resolve(operation);
	try {
		return await awaitCapability(pending, signal, deadline, now);
	} catch (error) {
		void pending.then((resource) => resource.dispose()).catch(() => undefined);
		throw error;
	}
}

function createDisposer(resources: readonly { dispose(): Promise<void> | void }[]): () => Promise<void> {
	let operation: Promise<void> | undefined;
	return () => {
		if (operation) return operation;
		operation = (async () => {
			const failures: unknown[] = [];
			for (const resource of [...resources].reverse()) {
				try {
					await resource.dispose();
				} catch (error) {
					failures.push(error);
				}
			}
			if (failures.length === 1) throw failures[0];
			if (failures.length > 1) throw new AggregateError(failures, "Run capability disposal failed");
		})();
		return operation;
	};
}

export function createRunCapabilityHost(options: CreateRunCapabilityHostOptions): RunCapabilityHost {
	const contributors = [...options.contributors].sort((left, right) => compareText(left.id, right.id));
	const contributorIds = new Set<string>();
	for (const contributor of contributors) {
		if (!contributor.id || contributor.id === "model" || contributorIds.has(contributor.id)) {
			throw new Error(`Duplicate, reserved, or empty Run capability source id: ${contributor.id}`);
		}
		contributorIds.add(contributor.id);
	}
	return Object.freeze({
		acquire: async (context: RunCapabilityAcquireContext): Promise<RunCapabilityLease> => {
			const resources: { dispose(): Promise<void> | void }[] = [];
			try {
				const model = await awaitResource(
					options.model.acquire(context.selection, context.signal),
					context.signal,
					context.deadline,
					options.now,
				);
				resources.push(model);
				const contributions: Array<{
					readonly source: RunCapabilitySource;
					readonly lease: RunCapabilityContributionLease;
				}> = [];
				for (const source of contributors) {
					const lease = await awaitResource(
						source.acquire({ model: model.model, signal: context.signal }),
						context.signal,
						context.deadline,
						options.now,
					);
					resources.push(lease);
					contributions.push({ source, lease });
				}

				const toolContributions: RunToolContribution[] = [
					...context.baseTools,
					...contributions.flatMap(({ lease }) => lease.tools),
				].filter(({ effect }) => context.mode === "write" || effect === "read");
				const tools = Object.freeze([...context.bindTools(Object.freeze(toolContributions))]);
				const projectInstructions = await awaitCapability(
					options.projectInstructions?.(context.placement),
					context.signal,
					context.deadline,
					options.now,
				);
				const prompt = Object.freeze(
					options.systemPrompt ??
						buildSystemPrompt({
							workspace: context.placement.root,
							platform: options.platform,
							timestamp: options.now(),
							tools: tools.map((tool) => ({ name: tool.name, description: tool.description })),
							capabilities: {
								interactionMode: options.interactionMode === "interactive" ? "interactive" : "print",
							},
							...(projectInstructions === undefined ? {} : { projectInstructions }),
							fragments: Object.freeze(contributions.flatMap(({ lease }) => lease.promptFragments)),
						}),
				);
				const dispose = createDisposer(resources);
				return Object.freeze({
					model,
					tools,
					prompt,
					revisions: Object.freeze([
						Object.freeze({ source: "model", revision: model.revision }),
						...contributions.map(({ source, lease }) =>
							Object.freeze({ source: source.id, revision: lease.revision }),
						),
					]),
					dispose,
				});
			} catch (error) {
				try {
					await createDisposer(resources)();
				} catch (disposeError) {
					throw new AggregateError([error, disposeError], "Run capability acquisition failed during rollback");
				}
				throw error;
			}
		},
	});
}
