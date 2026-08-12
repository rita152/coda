import type { AgentSeed, MessageId } from "@coda/agent";
import { describe, expect, it, vi } from "vitest";
import { DraftSession } from "../src/session/draft-session.ts";
import { SessionHistoryReader } from "../src/session/session-history-reader.ts";
import type { Session, SessionDescriptor, SessionId } from "../src/session/types.ts";

describe("DraftSession", () => {
	it("stays process-local when an empty Draft closes", async () => {
		const materialize = vi.fn(async () => fauxSession(descriptor()));
		const draft = new DraftSession({ descriptor: descriptor(), materialize });

		expect(draft.seed).toEqual({ version: 1, messages: [], pendingFollowUps: [] });
		expect(draft.materialized).toBe(false);
		await draft.close();

		expect(materialize).not.toHaveBeenCalled();
	});

	it("materializes once on the first durable record and forwards buffered media", async () => {
		const target = fauxSession(descriptor());
		const materialize = vi.fn(async () => target);
		const draft = new DraftSession({ descriptor: descriptor(), materialize });
		const registration = {
			reference: {
				type: "media" as const,
				digest: "a".repeat(64),
				filename: "image.png",
				mimeType: "image/png",
				width: 1,
				height: 1,
				bytes: 1,
				rendition: {
					digest: "b".repeat(64),
					mimeType: "image/png",
					width: 1,
					height: 1,
					bytes: 1,
				},
			},
			modelPath: "/tmp/model.png",
		};
		draft.registerMedia([registration]);
		draft.stageInitialChanges([{ type: "permission_selected", profile: "read-only" }]);

		await Promise.all([
			draft.record({ type: "permission_selected", profile: "read-only" }),
			draft.record({
				type: "model_selected",
				model: { provider: "provider", id: "model" },
				reasoning: "medium",
			}),
		]);

		expect(materialize).toHaveBeenCalledOnce();
		expect(draft.materialized).toBe(true);
		expect(target.registerMedia).toHaveBeenCalledWith([registration]);
		expect(target.record).toHaveBeenCalledTimes(3);
		expect(target.record).toHaveBeenNthCalledWith(1, { type: "permission_selected", profile: "read-only" });
		await draft.close();
		expect(target.close).toHaveBeenCalledOnce();
	});

	it("keeps a captured history reader bound across materialization", async () => {
		const seed: AgentSeed = {
			version: 1,
			messages: [
				{
					id: "message:restored" as MessageId,
					message: { role: "user", content: "restored constraint", timestamp: 1 },
				},
			],
			pendingFollowUps: [],
		};
		const target = fauxSession(descriptor(), seed);
		const draft = new DraftSession({ descriptor: descriptor(), materialize: async () => target });
		const history = draft.history;

		expect(history.read().messages).toEqual([]);
		await draft.record({ type: "permission_selected", profile: "read-only" });
		expect(history.read().messages).toMatchObject([{ id: "message:restored", role: "user" }]);
		await draft.close();
	});
});

function descriptor(): SessionDescriptor {
	return {
		id: "session-draft" as SessionId,
		workspace: { id: "workspace", path: "/workspace" },
		createdAt: 1,
		persistent: true,
	};
}

function fauxSession(
	sessionDescriptor: SessionDescriptor,
	seed: AgentSeed = { version: 1, messages: [], pendingFollowUps: [] },
): Session {
	return {
		descriptor: sessionDescriptor,
		seed,
		restored: {},
		recoverableFollowUps: [],
		composerSubmissions: [],
		toolInvocations: [],
		history: new SessionHistoryReader({ sessionId: sessionDescriptor.id, messages: () => seed.messages }),
		runEvidence: [],
		mediaReferences: new Map(),
		registerMedia: vi.fn(),
		attach: vi.fn(() => () => undefined),
		record: vi.fn(async () => undefined),
		close: vi.fn(async () => undefined),
	};
}
