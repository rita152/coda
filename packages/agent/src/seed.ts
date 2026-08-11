import type { Message } from "@coda/ai";
import { AgentError } from "./errors.ts";
import { isPersistenceSafeId } from "./identities.ts";
import { cloneFrozen } from "./immutable.ts";
import type { AgentMessage, AgentSeed, FollowUp } from "./types.ts";

interface ValidatedSeed {
	readonly messages: readonly AgentMessage[];
	readonly pendingFollowUps: readonly FollowUp[];
}

function invalid(message: string, cause?: unknown): never {
	throw new AgentError("invalid_seed", message, cause === undefined ? undefined : { cause });
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function validInput(value: unknown): boolean {
	if (typeof value === "string") return value.trim().length > 0;
	if (!Array.isArray(value) || value.length === 0) return false;
	return value.every((block) => {
		if (!isRecord(block)) return false;
		if (block.type === "text") return isNonEmptyString(block.text);
		if (block.type === "skill") return isNonEmptyString(block.name) && isNonEmptyString(block.path);
		return block.type === "image" && isNonEmptyString(block.data) && isNonEmptyString(block.mimeType);
	});
}

function validateUserMessage(message: Record<string, unknown>): void {
	if (!validInput(message.content)) invalid("Agent Seed contains an invalid User Message");
}

function validateAssistantMessage(message: Record<string, unknown>): void {
	if (!Array.isArray(message.content)) invalid("Agent Seed contains an invalid Assistant Message content array");
	if (!isNonEmptyString(message.api) || !isNonEmptyString(message.provider) || !isNonEmptyString(message.model)) {
		invalid("Agent Seed Assistant Messages require api, provider, and model identities");
	}
	if (message.stopReason !== "stop" && message.stopReason !== "length" && message.stopReason !== "toolUse") {
		invalid("Agent Seed may contain only completed, committed Assistant Messages");
	}
	for (const block of message.content) {
		if (!isRecord(block) || (block.type !== "text" && block.type !== "thinking" && block.type !== "toolCall")) {
			invalid("Agent Seed contains an invalid Assistant Message content block");
		}
		if (block.type === "toolCall") {
			if (!isNonEmptyString(block.id) || !isNonEmptyString(block.name) || !isRecord(block.arguments)) {
				invalid("Agent Seed contains an invalid Tool Call");
			}
		}
	}
}

function validateToolResultMessage(message: Record<string, unknown>): void {
	if (!isNonEmptyString(message.toolCallId) || !isNonEmptyString(message.toolName)) {
		invalid("Agent Seed contains an invalid Tool Result identity");
	}
	if (!Array.isArray(message.content) || typeof message.isError !== "boolean") {
		invalid("Agent Seed contains an invalid Tool Result Message");
	}
}

function validateMessage(value: unknown): asserts value is Message {
	if (!isRecord(value) || !Number.isFinite(value.timestamp)) invalid("Agent Seed contains an invalid Message");
	switch (value.role) {
		case "user":
			validateUserMessage(value);
			break;
		case "assistant":
			validateAssistantMessage(value);
			break;
		case "toolResult":
			validateToolResultMessage(value);
			break;
		default:
			invalid("Agent Seed contains an unknown Message role");
	}
}

function validateTranscript(messages: readonly AgentMessage[]): void {
	const pendingCalls = new Map<string, string>();
	for (const entry of messages) {
		const message = entry.message;
		if (pendingCalls.size > 0 && message.role !== "toolResult") {
			invalid("Agent Seed has unresolved Tool Invocations before the next transcript Message");
		}
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				if (pendingCalls.has(block.id)) invalid(`Agent Seed repeats Tool Call ID "${block.id}" in one batch`);
				pendingCalls.set(block.id, block.name);
			}
			continue;
		}
		if (message.role !== "toolResult") continue;
		const expectedName = pendingCalls.get(message.toolCallId);
		if (expectedName === undefined) invalid(`Agent Seed contains orphan Tool Result "${message.toolCallId}"`);
		if (expectedName !== message.toolName) {
			invalid(`Agent Seed Tool Result "${message.toolCallId}" does not match its Tool name`);
		}
		pendingCalls.delete(message.toolCallId);
	}
	if (pendingCalls.size > 0) invalid("Agent Seed contains unresolved Tool Invocations");
}

export function validateAgentSeed(seed: AgentSeed): ValidatedSeed {
	if (
		!isRecord(seed) ||
		seed.version !== 1 ||
		!Array.isArray(seed.messages) ||
		!Array.isArray(seed.pendingFollowUps)
	) {
		invalid("Agent Seed must use the version 1 idle schema");
	}
	const allowedKeys = new Set(["version", "messages", "pendingFollowUps"]);
	if (Object.keys(seed).some((key) => !allowedKeys.has(key))) {
		invalid("Agent Seed contains fields outside the version 1 idle schema");
	}

	let snapshot: AgentSeed;
	try {
		snapshot = cloneFrozen(seed) as AgentSeed;
	} catch (error) {
		invalid("Agent Seed must be structured-cloneable", error);
	}
	const identities = new Set<string>();
	for (const entry of snapshot.messages) {
		if (!isRecord(entry) || !isPersistenceSafeId(entry.id)) {
			invalid("Agent Seed contains an invalid Message identity");
		}
		if (identities.has(entry.id)) invalid(`Agent Seed contains duplicate identity "${entry.id}"`);
		identities.add(entry.id);
		validateMessage(entry.message);
	}
	validateTranscript(snapshot.messages);

	for (const followUp of snapshot.pendingFollowUps) {
		if (!isRecord(followUp) || !isPersistenceSafeId(followUp.id) || !validInput(followUp.content)) {
			invalid("Agent Seed contains an invalid pending Follow-up");
		}
		if (identities.has(followUp.id)) invalid(`Agent Seed contains duplicate identity "${followUp.id}"`);
		identities.add(followUp.id);
	}
	return { messages: snapshot.messages, pendingFollowUps: snapshot.pendingFollowUps };
}
