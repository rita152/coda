import type { AgentTool } from "@coda/agent";
import { Type } from "@coda/ai";
import {
	SESSION_HISTORY_CURSOR_MAX_LENGTH,
	SESSION_HISTORY_MAX_LIMIT,
	SessionHistoryCursorError,
	type SessionHistoryReadPort,
} from "../session/session-history-reader.ts";
import { toolFailure } from "./failure.ts";

const ReadSessionHistoryParameters = Type.Object(
	{
		cursor: Type.Optional(Type.String({ minLength: 1, maxLength: SESSION_HISTORY_CURSOR_MAX_LENGTH })),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: SESSION_HISTORY_MAX_LIMIT })),
	},
	{ additionalProperties: false },
);

export function createReadSessionHistoryTool(
	history: SessionHistoryReadPort,
): AgentTool<typeof ReadSessionHistoryParameters> {
	return {
		name: "read_session_history",
		description:
			"Read a bounded page of committed Session Messages omitted from the active Context Window. The newest page is returned first in chronological order; pass nextCursor to continue toward older Messages.",
		parameters: ReadSessionHistoryParameters,
		replaySafety: "safe",
		parallelSafe: true,
		execute: (arguments_, context) => {
			context.signal.throwIfAborted();
			try {
				const page = history.read(arguments_);
				const contentTruncated = page.messages.some((message) => message.contentTruncated);
				return {
					content: JSON.stringify(page),
					observation: {
						status: "ok",
						truncated: page.hasMoreBefore || contentTruncated,
						facts: {
							messageCount: page.messages.length,
							hasMoreBefore: page.hasMoreBefore,
							contentTruncated,
						},
					},
					details: {
						messageCount: page.messages.length,
						hasMoreBefore: page.hasMoreBefore,
						contentTruncated,
					},
				};
			} catch (error) {
				if (error instanceof SessionHistoryCursorError) {
					return toolFailure(
						error.code === "malformed_cursor"
							? "Session history cursor is malformed"
							: "Session history cursor is stale or belongs to another Session",
						{ code: error.code },
					);
				}
				throw error;
			}
		},
	};
}
