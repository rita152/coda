import type { AgentEvent, AgentMessage, AgentSeed, AttemptId, Immutable, MessageId, ToolInvocation } from "@coda/agent";
import type { AssistantMessage, ToolCall, ToolResultMessage, UserMessage } from "@coda/ai";
import type { SessionToolLifecycle } from "../session/types.ts";

export type TimelineToolState =
	| "awaiting_approval"
	| "running"
	| "success"
	| "failed"
	| "denied"
	| "aborted"
	| "skipped"
	| "interrupted";

export interface TimelineUserEntry {
	readonly kind: "user";
	readonly id: string;
	readonly messageId: string;
	readonly text: string;
	readonly message: Immutable<UserMessage>;
	readonly timestamp: number;
}

export interface TimelineAssistantEntry {
	readonly kind: "assistant";
	readonly id: string;
	readonly messageId: string;
	readonly contentIndex: number;
	readonly text: string;
	readonly phase: "streaming" | "complete";
	readonly timestamp: number;
}

export interface TimelineThinkingEntry {
	readonly kind: "thinking";
	readonly id: string;
	readonly messageId: string;
	readonly contentIndex: number;
	readonly text: string;
	readonly redacted: boolean;
	readonly phase: "streaming" | "complete";
	readonly timestamp: number;
}

export interface TimelineToolInvocation {
	readonly id: string;
	readonly resultMessageId: string;
	readonly providerToolCallId: string;
	readonly toolName: string;
	readonly arguments: Immutable<Record<string, unknown>>;
	readonly sourceIndex: number;
}

export interface TimelineToolEntry {
	readonly kind: "tool";
	readonly id: string;
	readonly turnId?: string;
	readonly invocation: TimelineToolInvocation;
	readonly state: TimelineToolState;
	readonly startedAt?: number;
	readonly endedAt?: number;
	readonly result?: AgentMessage<ToolResultMessage>;
}

export type TimelineEntry = TimelineUserEntry | TimelineAssistantEntry | TimelineThinkingEntry | TimelineToolEntry;

export interface TimelineMutation {
	readonly changed: boolean;
}

interface UserGroup {
	readonly kind: "user";
	readonly entry: TimelineUserEntry;
}

interface TextSlot {
	readonly kind: "assistant" | "thinking";
	readonly contentIndex: number;
	text: string;
	redacted: boolean;
	projected?: TimelineAssistantEntry | TimelineThinkingEntry;
}

interface ToolSlot {
	readonly kind: "tool";
	readonly contentIndex: number;
	providerToolCallId: string;
	toolName: string;
	arguments: Immutable<Record<string, unknown>>;
	invocation?: TimelineToolInvocation;
	state: TimelineToolState;
	startedAt?: number;
	endedAt?: number;
	result?: AgentMessage<ToolResultMessage>;
	projected?: TimelineToolEntry;
}

type AssistantSlot = TextSlot | ToolSlot;

interface AssistantGroup {
	readonly kind: "assistant";
	readonly messageId: string;
	readonly attemptId?: string;
	turnId?: string;
	readonly timestamp: number;
	phase: "streaming" | "complete";
	readonly slots: Map<number, AssistantSlot>;
}

type TimelineGroup = UserGroup | AssistantGroup;

/** Projects restored Messages and live Agent events into one presentation-neutral Timeline. */
export class SemanticTimeline {
	readonly #groups: TimelineGroup[] = [];
	readonly #assistantByMessage = new Map<string, AssistantGroup>();
	readonly #messageByAttempt = new Map<string, string>();
	readonly #toolByProviderId = new Map<string, ToolSlot>();
	readonly #toolByInvocationId = new Map<string, ToolSlot>();
	#cachedEntries?: readonly TimelineEntry[];

	constructor(seed?: AgentSeed, toolInvocations: readonly SessionToolLifecycle[] = []) {
		for (const message of seed?.messages ?? []) this.#hydrate(message);
		for (const lifecycle of toolInvocations) this.#restoreTool(lifecycle);
	}

	get entries(): readonly TimelineEntry[] {
		if (!this.#cachedEntries) this.#cachedEntries = Object.freeze(this.#projectEntries());
		return this.#cachedEntries;
	}

	get hasActiveTools(): boolean {
		return [...this.#toolByProviderId.values()].some(
			(slot) => slot.invocation && (slot.state === "running" || slot.state === "awaiting_approval"),
		);
	}

	accept(event: AgentEvent): TimelineMutation {
		let changed = false;
		switch (event.type) {
			case "run_start":
				this.#appendUser(event.inputMessage);
				changed = true;
				break;
			case "turn_start":
				for (const message of event.steeringMessages) this.#appendUser(message);
				changed = event.steeringMessages.length > 0;
				break;
			case "attempt_start":
				this.#ensureAssistant(event.messageId, event.attemptId, event.timestamp, event.turnId);
				changed = true;
				break;
			case "message_start":
				this.#ensureAssistant(event.messageId, event.attemptId, event.timestamp, event.turnId);
				changed = true;
				break;
			case "message_update":
				this.#applyDelta(event);
				changed = true;
				break;
			case "attempt_end":
				if (event.discarded) changed = this.#removeAssistant(event.messageId);
				break;
			case "message_end":
				this.#commitAssistant(event.message, event.attemptId, event.turnId);
				changed = true;
				break;
			case "tool_execution_start":
				this.#startTool(event.invocation, event.timestamp, event.turnId);
				changed = true;
				break;
			case "tool_execution_end":
				this.#finishTool(event.invocation, event.outcome, event.result, event.timestamp, event.turnId);
				changed = true;
				break;
			case "tool_execution_rejected":
				this.#rejectTool(event.invocation, event.reason, event.result, event.timestamp, event.turnId);
				changed = true;
				break;
			case "run_end":
				if (event.outcome !== "success") changed = this.#removeStreamingGroups() || changed;
				break;
		}
		if (changed) this.#invalidate();
		return Object.freeze({ changed });
	}

	setAwaitingApproval(invocationId: string, toolName: string): boolean {
		let slot = this.#toolByInvocationId.get(invocationId);
		if (!slot) {
			slot = [...this.#toolByProviderId.values()].find(
				(candidate) => !candidate.invocation && candidate.toolName === toolName,
			);
		}
		if (!slot) return false;
		if (!slot.invocation) {
			slot.invocation = freezeInvocation({
				id: invocationId,
				resultMessageId: `pending:${invocationId}`,
				providerToolCallId: slot.providerToolCallId,
				toolName: slot.toolName,
				arguments: slot.arguments,
				sourceIndex: slot.contentIndex,
			});
			this.#toolByInvocationId.set(invocationId, slot);
		}
		slot.state = "awaiting_approval";
		slot.projected = undefined;
		this.#invalidate();
		return true;
	}

	#hydrate(message: AgentMessage): void {
		switch (message.message.role) {
			case "user":
				this.#appendUser(message as AgentMessage<UserMessage>);
				break;
			case "assistant":
				this.#addCommittedAssistant(
					message as AgentMessage<AssistantMessage>,
					undefined,
					`restored:${message.id}`,
					false,
				);
				break;
			case "toolResult": {
				const result = message as AgentMessage<ToolResultMessage>;
				const slot = this.#toolByProviderId.get(result.message.toolCallId);
				if (slot) {
					slot.result = clone(result);
					slot.state = result.message.isError ? "failed" : "success";
					slot.endedAt = result.message.timestamp;
					slot.projected = undefined;
				}
				break;
			}
		}
		this.#invalidate();
	}

	#restoreTool(lifecycle: SessionToolLifecycle): void {
		const slot = this.#findOrCreateTool(lifecycle.invocation, lifecycle.turnId ?? "restored");
		this.#attachInvocation(slot, lifecycle.invocation);
		slot.startedAt = lifecycle.startedAt;
		slot.endedAt = lifecycle.finishedAt;
		slot.state = restoredToolState(lifecycle);
		slot.projected = undefined;
	}

	#appendUser(message: AgentMessage<UserMessage>): void {
		const snapshot = clone(message.message);
		this.#groups.push({
			kind: "user",
			entry: Object.freeze({
				kind: "user",
				id: `message:${message.id}`,
				messageId: message.id,
				text: userText(snapshot),
				message: snapshot,
				timestamp: snapshot.timestamp,
			}),
		});
	}

	#ensureAssistant(
		messageId: MessageId | string,
		attemptId: AttemptId | string,
		timestamp: number,
		turnId?: string,
	): AssistantGroup {
		const existing = this.#assistantByMessage.get(messageId);
		if (existing) {
			if (!existing.turnId && turnId) {
				existing.turnId = turnId;
				this.#invalidateProjectedSlots(existing);
			}
			return existing;
		}
		const group: AssistantGroup = {
			kind: "assistant",
			messageId,
			attemptId,
			turnId,
			timestamp,
			phase: "streaming",
			slots: new Map(),
		};
		this.#groups.push(group);
		this.#assistantByMessage.set(messageId, group);
		this.#messageByAttempt.set(attemptId, messageId);
		return group;
	}

	#applyDelta(event: Extract<AgentEvent, { type: "message_update" }>): void {
		const group = this.#ensureAssistant(event.messageId, event.attemptId, event.timestamp, event.turnId);
		const { delta } = event;
		switch (delta.type) {
			case "text_start":
				this.#ensureTextSlot(group, delta.contentIndex, "assistant").projected = undefined;
				break;
			case "text_delta": {
				const slot = this.#ensureTextSlot(group, delta.contentIndex, "assistant");
				slot.text += delta.delta;
				slot.projected = undefined;
				break;
			}
			case "text_end": {
				const slot = this.#ensureTextSlot(group, delta.contentIndex, "assistant");
				slot.text = delta.content;
				slot.projected = undefined;
				break;
			}
			case "thinking_start":
				this.#ensureTextSlot(group, delta.contentIndex, "thinking").projected = undefined;
				break;
			case "thinking_delta": {
				const slot = this.#ensureTextSlot(group, delta.contentIndex, "thinking");
				slot.text += delta.delta;
				slot.projected = undefined;
				break;
			}
			case "thinking_end": {
				const slot = this.#ensureTextSlot(group, delta.contentIndex, "thinking");
				slot.text = delta.content;
				slot.projected = undefined;
				break;
			}
			case "toolcall_end":
				this.#setToolCallSlot(group, delta.contentIndex, delta.toolCall, false);
				break;
		}
	}

	#ensureTextSlot(group: AssistantGroup, contentIndex: number, kind: TextSlot["kind"]): TextSlot {
		const current = group.slots.get(contentIndex);
		if (current?.kind === kind) return current;
		const slot: TextSlot = { kind, contentIndex, text: "", redacted: false };
		group.slots.set(contentIndex, slot);
		return slot;
	}

	#commitAssistant(message: AgentMessage<AssistantMessage>, attemptId?: string, turnId?: string): void {
		const existing = this.#assistantByMessage.get(message.id);
		if (existing) {
			this.#clearSlots(existing);
			existing.turnId ??= turnId;
			existing.phase = "complete";
			this.#fillAssistantSlots(existing, message.message.content, false);
			return;
		}
		this.#addCommittedAssistant(message, attemptId, turnId, false);
	}

	#addCommittedAssistant(
		message: AgentMessage<AssistantMessage>,
		attemptId: string | undefined,
		turnId: string | undefined,
		restored: boolean,
	): void {
		const group: AssistantGroup = {
			kind: "assistant",
			messageId: message.id,
			attemptId,
			turnId,
			timestamp: message.message.timestamp,
			phase: "complete",
			slots: new Map(),
		};
		this.#fillAssistantSlots(group, message.message.content, restored);
		this.#groups.push(group);
		this.#assistantByMessage.set(message.id, group);
		if (attemptId) this.#messageByAttempt.set(attemptId, message.id);
	}

	#fillAssistantSlots(
		group: AssistantGroup,
		content: Immutable<AssistantMessage["content"]>,
		restored: boolean,
	): void {
		for (const [contentIndex, block] of content.entries()) {
			if (block.type === "text") {
				group.slots.set(contentIndex, {
					kind: "assistant",
					contentIndex,
					text: block.text,
					redacted: false,
				});
			} else if (block.type === "thinking") {
				group.slots.set(contentIndex, {
					kind: "thinking",
					contentIndex,
					text: block.thinking,
					redacted: block.redacted ?? false,
				});
			} else {
				this.#setToolCallSlot(group, contentIndex, block, restored);
			}
		}
	}

	#setToolCallSlot(group: AssistantGroup, contentIndex: number, call: Immutable<ToolCall>, restored: boolean): void {
		const slot: ToolSlot = {
			kind: "tool",
			contentIndex,
			providerToolCallId: call.id,
			toolName: call.name,
			arguments: clone(call.arguments),
			state: restored ? "interrupted" : "running",
		};
		group.slots.set(contentIndex, slot);
		this.#toolByProviderId.set(call.id, slot);
	}

	#startTool(invocation: Immutable<ToolInvocation>, timestamp: number, turnId: string): void {
		const slot = this.#findOrCreateTool(invocation, turnId);
		this.#attachInvocation(slot, invocation);
		slot.state = "running";
		slot.startedAt = timestamp;
		slot.projected = undefined;
	}

	#finishTool(
		invocation: Immutable<ToolInvocation>,
		outcome: "success" | "error" | "aborted",
		result: AgentMessage,
		timestamp: number,
		turnId: string,
	): void {
		const slot = this.#findOrCreateTool(invocation, turnId);
		this.#attachInvocation(slot, invocation);
		slot.state = outcome === "success" ? "success" : outcome === "error" ? "failed" : "aborted";
		slot.endedAt = timestamp;
		if (result.message.role === "toolResult") slot.result = clone(result as AgentMessage<ToolResultMessage>);
		slot.projected = undefined;
	}

	#rejectTool(
		invocation: Immutable<ToolInvocation>,
		reason: "missing" | "invalid" | "policy" | "aborted" | "not_started",
		result: AgentMessage,
		timestamp: number,
		turnId: string,
	): void {
		const slot = this.#findOrCreateTool(invocation, turnId);
		this.#attachInvocation(slot, invocation);
		slot.state =
			reason === "policy"
				? "denied"
				: reason === "aborted"
					? "aborted"
					: reason === "not_started"
						? "skipped"
						: "failed";
		slot.endedAt = timestamp;
		if (result.message.role === "toolResult") slot.result = clone(result as AgentMessage<ToolResultMessage>);
		slot.projected = undefined;
	}

	#findOrCreateTool(invocation: Immutable<ToolInvocation>, turnId: string): ToolSlot {
		const existing =
			this.#toolByInvocationId.get(invocation.id) ?? this.#toolByProviderId.get(invocation.providerToolCallId);
		if (existing) return existing;
		const group: AssistantGroup = {
			kind: "assistant",
			messageId: `tool-group:${invocation.id}`,
			turnId,
			timestamp: 0,
			phase: "complete",
			slots: new Map(),
		};
		const slot: ToolSlot = {
			kind: "tool",
			contentIndex: invocation.sourceIndex,
			providerToolCallId: invocation.providerToolCallId,
			toolName: invocation.toolName,
			arguments: clone(invocation.arguments),
			state: "running",
		};
		group.slots.set(invocation.sourceIndex, slot);
		this.#groups.push(group);
		this.#assistantByMessage.set(group.messageId, group);
		this.#toolByProviderId.set(invocation.providerToolCallId, slot);
		return slot;
	}

	#attachInvocation(slot: ToolSlot, invocation: Immutable<ToolInvocation>): void {
		const previousId = slot.invocation?.id;
		if (previousId) this.#toolByInvocationId.delete(previousId);
		slot.invocation = freezeInvocation(invocation);
		slot.providerToolCallId = invocation.providerToolCallId;
		slot.toolName = invocation.toolName;
		slot.arguments = clone(invocation.arguments);
		this.#toolByInvocationId.set(invocation.id, slot);
		slot.projected = undefined;
	}

	#removeAssistant(messageId: string): boolean {
		const group = this.#assistantByMessage.get(messageId);
		if (!group) return false;
		this.#clearSlots(group);
		this.#assistantByMessage.delete(messageId);
		if (group.attemptId) this.#messageByAttempt.delete(group.attemptId);
		const index = this.#groups.indexOf(group);
		if (index >= 0) this.#groups.splice(index, 1);
		return true;
	}

	#removeStreamingGroups(): boolean {
		let changed = false;
		for (const group of [...this.#groups]) {
			if (group.kind === "assistant" && group.phase === "streaming") {
				changed = this.#removeAssistant(group.messageId) || changed;
			}
		}
		return changed;
	}

	#clearSlots(group: AssistantGroup): void {
		for (const slot of group.slots.values()) {
			if (slot.kind !== "tool") continue;
			if (this.#toolByProviderId.get(slot.providerToolCallId) === slot) {
				this.#toolByProviderId.delete(slot.providerToolCallId);
			}
			if (slot.invocation && this.#toolByInvocationId.get(slot.invocation.id) === slot) {
				this.#toolByInvocationId.delete(slot.invocation.id);
			}
		}
		group.slots.clear();
	}

	#projectEntries(): TimelineEntry[] {
		const entries: TimelineEntry[] = [];
		for (const group of this.#groups) {
			if (group.kind === "user") {
				entries.push(group.entry);
				continue;
			}
			const slots = [...group.slots.values()].sort((left, right) => left.contentIndex - right.contentIndex);
			for (const slot of slots) {
				if (slot.kind === "tool") {
					if (!slot.invocation) continue;
					slot.projected ??= Object.freeze({
						kind: "tool",
						id: `tool:${slot.invocation.id}`,
						turnId: group.turnId,
						invocation: slot.invocation,
						state: slot.state,
						startedAt: slot.startedAt,
						endedAt: slot.endedAt,
						result: slot.result,
					});
					entries.push(slot.projected);
					continue;
				}
				if (!slot.projected) {
					const common = {
						id: `message:${group.messageId}:content:${slot.contentIndex}`,
						messageId: group.messageId,
						contentIndex: slot.contentIndex,
						text: slot.text,
						phase: group.phase,
						timestamp: group.timestamp,
					} as const;
					slot.projected =
						slot.kind === "assistant"
							? Object.freeze({ kind: "assistant", ...common })
							: Object.freeze({ kind: "thinking", ...common, redacted: slot.redacted });
				}
				entries.push(slot.projected);
			}
		}
		return entries;
	}

	#invalidate(): void {
		this.#cachedEntries = undefined;
	}

	#invalidateProjectedSlots(group: AssistantGroup): void {
		for (const slot of group.slots.values()) slot.projected = undefined;
	}
}

function userText(message: Immutable<UserMessage>): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => (block.type === "text" ? block.text : ""))
		.join("");
}

function freezeInvocation(invocation: {
	readonly id: string;
	readonly resultMessageId: string;
	readonly providerToolCallId: string;
	readonly toolName: string;
	readonly arguments: Immutable<Record<string, unknown>>;
	readonly sourceIndex: number;
}): TimelineToolInvocation {
	return Object.freeze({
		id: invocation.id,
		resultMessageId: invocation.resultMessageId,
		providerToolCallId: invocation.providerToolCallId,
		toolName: invocation.toolName,
		arguments: clone(invocation.arguments),
		sourceIndex: invocation.sourceIndex,
	});
}

function restoredToolState(lifecycle: SessionToolLifecycle): TimelineToolState {
	switch (lifecycle.outcome) {
		case "success":
			return "success";
		case "error":
			return "failed";
		case "aborted":
			return "aborted";
		case "rejected":
			if (lifecycle.rejectionReason === "policy") return "denied";
			if (lifecycle.rejectionReason === "aborted") return "aborted";
			if (lifecycle.rejectionReason === "not_started") return "skipped";
			return "failed";
		case "interrupted":
		case undefined:
			return "interrupted";
	}
}

function clone<T>(value: T): T {
	return structuredClone(value);
}
