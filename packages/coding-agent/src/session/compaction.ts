import type { AgentMessage, MessageId } from "@coda/agent";

export type CompactionReason = "manual" | "auto" | "overflow";

export interface CompactionCheckpoint {
	readonly version: 1;
	readonly windowId: string;
	readonly previousWindowId?: string;
	readonly reason: CompactionReason;
	readonly summary: string;
	readonly focus?: string;
	readonly coveredThroughMessageId: MessageId;
	readonly coveredMessageIds: readonly MessageId[];
	readonly retainedMessageIds: readonly MessageId[];
	readonly replacementHistory: readonly AgentMessage[];
	readonly model: {
		readonly provider: string;
		readonly id: string;
		readonly contextWindow: number;
		readonly maxTokens: number;
	};
	readonly usage: {
		readonly beforeEstimatedTokens: number;
		readonly afterEstimatedTokens: number;
		readonly summaryInputTokens: number;
		readonly summaryOutputTokens: number;
		readonly summaryTotalTokens: number;
		readonly summaryCost?: number;
		readonly cumulativeCost?: number;
	};
	readonly summaryPrompt: {
		readonly version: "1";
		readonly sha256: string;
		readonly calls: number;
	};
	readonly createdAt: number;
}
