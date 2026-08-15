import type { AgentState, Clock } from "@coda/agent";
import type { Api, AuthPrompt, Model, MutableModels } from "@coda/ai";
import type { DiagnosticSink, Keybinding, Scheduler, Terminal } from "@coda/tui";
import type { ApplicationIO } from "../host/application-io.ts";
import type { ModelSelection } from "../models/model-selection.ts";
import type { ProviderManager } from "../models/provider-manager.ts";
import { availableReasoningEfforts, effectiveReasoningEffort } from "../models/reasoning-effort.ts";
import type { SessionWorkController } from "../runtime/session-work-controller.ts";
import type { Session } from "../session/types.ts";
import type { UserSettings } from "../settings/types.ts";
import type { FullScreenOutputGate } from "../ui/full-screen-output.ts";
import type { InteractiveProcessLifecycle } from "../ui/process-lifecycle.ts";
import { type PromptRuntime, promptTextFromTerminal, selectFromTerminal } from "../ui/prompts.ts";
import type { InteractiveSessionOptions } from "../ui/run-interactive.ts";
import { sessionCostSnapshot } from "../ui/session-status.ts";
import type { SessionStatusLineSnapshot } from "../ui/status-line.ts";

export function createEffortCommand(
	session: Session,
	work: SessionWorkController,
): NonNullable<InteractiveSessionOptions["effortCommand"]> {
	return {
		snapshot: () => ({
			current: work.state().selection.reasoning,
			available: availableReasoningEfforts(work.state().selection.model),
		}),
		select: async (effort) => {
			const selected = work.state().selection;
			const reasoning = effectiveReasoningEffort(selected.model, effort);
			if (reasoning !== effort) {
				throw new Error(
					`Reasoning effort ${effort} is not supported by ${selected.model.provider}/${selected.model.id}`,
				);
			}
			await session.record({
				type: "model_selected",
				model: { provider: selected.model.provider, id: selected.model.id },
				reasoning,
			});
			await work.selectReasoning(reasoning);
			return reasoning;
		},
	};
}

export function promptRuntime(
	options: {
		readonly runtime: {
			readonly clock: Clock;
			readonly scheduler?: Scheduler;
			readonly interactiveLifecycle?: InteractiveProcessLifecycle;
		};
		readonly keybindings?: readonly Keybinding[];
		readonly diagnostics?: DiagnosticSink;
		readonly fullScreenOutput?: FullScreenOutputGate;
	},
	terminal: Terminal,
): PromptRuntime {
	if (!options.runtime.scheduler) {
		throw new Error("Interactive mode requires injected Terminal and Scheduler capabilities");
	}
	return {
		terminal,
		clock: options.runtime.clock,
		scheduler: options.runtime.scheduler,
		keybindings: options.keybindings ?? [],
		diagnostics: options.diagnostics,
		fullScreenOutput: options.fullScreenOutput,
		lifecycle: options.runtime.interactiveLifecycle,
	};
}

async function answerAuthPrompt(runtime: PromptRuntime, prompt: AuthPrompt): Promise<string> {
	if (prompt.type === "select") {
		const selected = await selectFromTerminal(runtime, prompt.message, prompt.options);
		if (selected === undefined) throw new Error("Authentication was cancelled");
		return selected;
	}
	const value = await promptTextFromTerminal(runtime, {
		message: prompt.message,
		placeholder: prompt.placeholder,
		secret: prompt.type === "secret",
	});
	if (value === undefined) throw new Error("Authentication was cancelled");
	return value;
}

export async function authenticateInteractively(
	options: { readonly models: MutableModels; readonly io: Pick<ApplicationIO, "stderr"> },
	providerId: string,
	runtime: PromptRuntime,
): Promise<void> {
	await options.models.login(providerId, "api_key", {
		prompt: (prompt) => answerAuthPrompt(runtime, prompt),
		notify: (event) => {
			const message =
				event.type === "auth_url"
					? `Authenticate at ${event.url}`
					: event.type === "device_code"
						? `Authenticate at ${event.verificationUri} with code ${event.userCode}`
						: event.message;
			void options.io.stderr.write(`coda: ${message}\n`);
		},
	});
}

export async function selectModelInteractively(
	options: { readonly models: MutableModels; readonly io: Pick<ApplicationIO, "stderr"> },
	runtime: PromptRuntime,
): Promise<ModelSelection> {
	let available = await options.models.getAvailable();
	if (available.length === 0) {
		const loginProviders = options.models
			.getProviders()
			.filter((provider) => provider.auth.apiKey?.login)
			.sort((left, right) => left.id.localeCompare(right.id));
		if (loginProviders.length === 0) throw new Error("No authenticated Models are available");
		const providerId =
			loginProviders.length === 1
				? loginProviders[0]!.id
				: await selectFromTerminal(
						runtime,
						"Select a Provider to authenticate",
						loginProviders.map((provider) => ({
							id: provider.id,
							label: provider.name,
							description: provider.id,
						})),
					);
		if (!providerId) throw new Error("Provider selection was cancelled");
		await authenticateInteractively(options, providerId, runtime);
		available = await options.models.getAvailable();
	}
	if (available.length === 0) throw new Error("No authenticated Models are available");
	const sorted = [...available].sort(
		(left, right) => left.provider.localeCompare(right.provider) || left.id.localeCompare(right.id),
	);
	const selected = await selectFromTerminal(
		runtime,
		"Select a Model",
		sorted.map((model) => ({
			id: `${model.provider}\0${model.id}`,
			label: `${model.provider}/${model.id}`,
			description: `${model.name} • ${model.api}${model.reasoning ? " • reasoning" : ""}`,
		})),
	);
	if (!selected) throw new Error("Model selection was cancelled");
	const separator = selected.indexOf("\0");
	return { provider: selected.slice(0, separator), id: selected.slice(separator + 1) };
}

export function interactiveStatusLineSnapshot(
	work: SessionWorkController,
	session: Session,
): SessionStatusLineSnapshot {
	const snapshot = work.state();
	const selected = snapshot.selection;
	const context = contextUsage(snapshot.messages, selected.model);
	const cost = sessionCostSnapshot(
		snapshot.messages,
		session.compactionCheckpoint?.usage.cumulativeCost ?? 0,
		session.discardedModelCost,
		selected.model.cost !== undefined,
	);
	return {
		modelSupportsReasoning: selected.model.reasoning,
		context: {
			usedTokens: context.usedTokens,
			windowTokens: context.windowTokens,
			estimated: context.estimated || latestUsageComesFromAnotherModel(snapshot.messages, selected.model),
		},
		...(cost ? { cost } : {}),
	};
}

export function contextUsage(
	messages: AgentState["messages"],
	model: Model<Api>,
): { readonly usedTokens: number; readonly windowTokens: number; readonly estimated: boolean } {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]?.message;
		if (message?.role !== "assistant" && message?.role !== "toolResult") continue;
		const usage = message.usage;
		if (!usage) continue;
		const usedTokens = usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
		if (usedTokens > 0) return { usedTokens, windowTokens: model.contextWindow, estimated: false };
	}
	const bytes = new TextEncoder().encode(JSON.stringify(messages)).byteLength;
	return { usedTokens: Math.ceil(bytes / 4), windowTokens: model.contextWindow, estimated: true };
}

export function latestUsageComesFromAnotherModel(messages: AgentState["messages"], model: Model<Api>): boolean {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]?.message;
		if (message?.role !== "assistant" || message.stopReason === "aborted" || message.stopReason === "error") continue;
		const usageTokens =
			message.usage.totalTokens ||
			message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite;
		if (usageTokens === 0) continue;
		return message.provider !== model.provider || message.model !== model.id;
	}
	return false;
}

export function persistCustomProviders(
	settings: UserSettings,
	configurations: ProviderManager["configurations"],
): UserSettings {
	return { ...settings, customProviders: configurations };
}

export async function refreshProviderAuth(input: {
	readonly providerId: string;
	readonly targets: readonly { readonly work: SessionWorkController; readonly apiKey?: string }[];
	readonly models: MutableModels;
	readonly clock: Clock;
}): Promise<void> {
	for (const { work, apiKey } of input.targets) {
		const selected = work.state().selection;
		if (selected.model.provider !== input.providerId) continue;
		const model = input.models.getModel(input.providerId, selected.model.id) ?? selected.model;
		const authSnapshot = await input.models.getAuth(model, { apiKey, clock: input.clock });
		await work.select({
			...selected,
			model,
			reasoning: effectiveReasoningEffort(model, selected.reasoning),
			authSnapshot,
		});
	}
}
