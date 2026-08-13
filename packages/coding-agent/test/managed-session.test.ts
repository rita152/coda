import type { IdGenerator, IdKind, QueueItemId } from "@coda/agent";
import { describe, expect, it } from "vitest";
import { ManagedSession, type SessionJournal } from "../src/session/managed-session.ts";
import type { SessionRecord } from "../src/session/records.ts";
import type { SessionDescriptor } from "../src/session/types.ts";

describe("ManagedSession", () => {
	it("projects durable Composer submissions and filters retracted entries", () => {
		const descriptor = {
			id: "session:history",
			workspace: { id: "workspace", path: "/workspace" },
			createdAt: 1,
			persistent: true,
		} as SessionDescriptor;
		const session = new ManagedSession(
			{
				descriptor,
				records: linearRecords(descriptor, [
					{
						type: "message_committed",
						payload: {
							message: { id: "message:legacy", message: { role: "user", content: "!legacy", timestamp: 1 } },
						},
					},
					{
						type: "composer_submission_recorded",
						payload: { submission: { id: "submission:1", kind: "steering", text: "new" } },
					},
					{
						type: "composer_submission_recorded",
						payload: {
							submission: {
								id: "submission:2",
								kind: "follow_up",
								text: "reclaimed",
								queueItemId: "queue:2",
							},
						},
					},
					{ type: "composer_submission_retracted", payload: { id: "submission:2" } },
				]),
				append: async () => undefined,
				close: async () => undefined,
			},
			{ clock: { now: () => 10 }, idGenerator: { generate: (kind) => `${kind}:new` } },
		);

		expect(session.composerSubmissions).toEqual([
			{ id: "legacy:message:legacy", kind: "prompt", text: "\\!legacy" },
			{ id: "submission:1", kind: "steering", text: "new" },
		]);
	});

	it("projects failed Follow-ups for recovery until they are reclaimed", () => {
		const descriptor = {
			id: "session:test",
			workspace: { id: "workspace", path: "/workspace" },
			createdAt: 1,
			persistent: true,
		} as SessionDescriptor;
		const queueId = "queue:failed" as QueueItemId;
		const records = linearRecords(descriptor, [
			{ type: "follow_up_enqueued", payload: { item: { id: queueId, content: "repair me" } } },
			{ type: "follow_up_consumed", payload: { id: queueId } },
			{
				type: "run_started",
				runId: "run:failed",
				payload: { source: "follow_up", queueItemId: queueId },
			},
			{
				type: "message_committed",
				runId: "run:failed",
				payload: {
					message: {
						id: "message:failed",
						message: { role: "user", content: "repair me", timestamp: 10 },
					},
				},
			},
			{
				type: "run_finished",
				runId: "run:failed",
				payload: { outcome: "error", failure: { kind: "runtime", message: "too large" } },
			},
		]);
		const idGenerator: IdGenerator = { generate: (kind: IdKind) => `${kind}:new` };
		const session = new ManagedSession(
			{ descriptor, records, append: async () => undefined, close: async () => undefined },
			{ clock: { now: () => 10 }, idGenerator },
		);

		expect(session.recoverableFollowUps).toEqual([
			{
				item: { id: queueId, content: "repair me" },
				state: "failed",
				failure: { kind: "runtime", message: "too large" },
				messageId: "message:failed",
			},
		]);

		const reclaimed = new ManagedSession(
			{
				descriptor,
				records: [
					...records,
					...linearRecords(descriptor, [{ type: "follow_up_reclaimed", payload: { id: queueId } }], records),
				],
				append: async () => undefined,
				close: async () => undefined,
			},
			{ clock: { now: () => 10 }, idGenerator },
		);
		expect(reclaimed.recoverableFollowUps).toEqual([]);
	});

	it("serializes concurrent records into one physical predecessor chain", async () => {
		let releaseFirst!: () => void;
		const firstAppendBlocked = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const appended: SessionRecord[] = [];
		let appendCalls = 0;
		const descriptor = {
			id: "session:test",
			workspace: { id: "workspace", path: "/workspace" },
			createdAt: 1,
			persistent: true,
		} as SessionDescriptor;
		const journal: SessionJournal = {
			descriptor,
			records: [],
			append: async (record) => {
				appendCalls++;
				if (appendCalls === 1) await firstAppendBlocked;
				appended.push(record);
			},
			close: async () => undefined,
		};
		let id = 0;
		const idGenerator: IdGenerator = { generate: (kind: IdKind) => `${kind}:${++id}` };
		const session = new ManagedSession(journal, { clock: { now: () => 10 }, idGenerator });
		const queueId = "queue:one" as QueueItemId;

		const enqueue = session.record({ type: "follow_up_enqueued", item: { id: queueId, content: "later" } });
		await Promise.resolve();
		const cancel = session.record({ type: "follow_up_canceled", id: queueId });
		releaseFirst();
		await Promise.all([enqueue, cancel]);

		expect(appended.map(({ sequence }) => sequence)).toEqual([1, 2]);
		expect(appended[0]?.previousRecordId).toBeNull();
		expect(appended[1]?.previousRecordId).toBe(appended[0]?.recordId);
	});

	it("projects exact Tool lifecycle identity for restored Timelines", () => {
		const descriptor = {
			id: "session:tools",
			workspace: { id: "workspace", path: "/workspace" },
			createdAt: 1,
			persistent: true,
		} as SessionDescriptor;
		const invocation = {
			id: "invocation:rejected",
			resultMessageId: "message:result",
			providerToolCallId: "provider:call",
			toolName: "write",
			arguments: { path: "a.ts" },
			sourceIndex: 2,
		} as const;
		const session = new ManagedSession(
			{
				descriptor,
				records: linearRecords(descriptor, [
					{ type: "tool_started", runId: "run:1", turnId: "turn:1", payload: { invocation } },
					{
						type: "tool_finished",
						runId: "run:1",
						turnId: "turn:1",
						payload: {
							invocation,
							outcome: "rejected",
							reason: "not_started",
							resultMessageId: "message:result",
						},
					},
				]),
				append: async () => undefined,
				close: async () => undefined,
			},
			{ clock: { now: () => 10 }, idGenerator: { generate: (kind) => `${kind}:new` } },
		);

		expect(session.toolInvocations).toEqual([
			{
				invocation,
				runId: "run:1",
				turnId: "turn:1",
				startedAt: 10,
				finishedAt: 10,
				outcome: "rejected",
				rejectionReason: "not_started",
				resultMessageId: "message:result",
			},
		]);
	});
});

function linearRecords(
	descriptor: SessionDescriptor,
	inputs: ReadonlyArray<Pick<SessionRecord, "type" | "payload" | "runId" | "turnId">>,
	prefix: readonly SessionRecord[] = [],
): SessionRecord[] {
	let previous = prefix.at(-1)?.recordId ?? null;
	return inputs.map((input, index) => {
		const sequence = prefix.length + index + 1;
		const record: SessionRecord = {
			...input,
			recordId: `record:${sequence}`,
			sessionId: descriptor.id,
			sequence,
			previousRecordId: previous,
			timestamp: 10,
		};
		previous = record.recordId;
		return record;
	});
}
