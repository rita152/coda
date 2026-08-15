import type { AgentMessage } from "@coda/agent";
import type { Usage } from "@coda/ai";
import type { StatusLineCostSnapshot } from "./status-line.ts";

export function sessionCostSnapshot(
	messages: readonly AgentMessage[],
	compactionCost: number | undefined,
	discardedModelCost: number | undefined,
	currentModelPriceKnown: boolean,
): StatusLineCostSnapshot | undefined {
	if (compactionCost === undefined || discardedModelCost === undefined || !currentModelPriceKnown) return undefined;
	let usd = compactionCost + discardedModelCost;
	for (const { message } of messages) {
		const usage = message.role === "assistant" || message.role === "toolResult" ? message.usage : undefined;
		if (!usage || usageTokens(usage) === 0) continue;
		if (!usage.cost || !Number.isFinite(usage.cost.total) || usage.cost.total < 0) return undefined;
		usd += usage.cost.total;
	}
	return { usd };
}

function usageTokens(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}
