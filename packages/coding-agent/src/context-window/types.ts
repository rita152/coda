import type { AgentMessage, MessageId } from "@coda/agent";

export type CompactionReason = "manual" | "auto" | "overflow";

/** Durable replacement Context Window committed without deleting the Session transcript. */
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
		/** Exact cost of the Model calls used to create this checkpoint, when priced. */
		readonly summaryCost?: number;
		/** Exact cumulative cost of every compaction committed through this checkpoint. */
		readonly cumulativeCost?: number;
	};
	readonly summaryPrompt: {
		readonly version: "1";
		readonly sha256: string;
		readonly calls: number;
	};
	readonly createdAt: number;
}
