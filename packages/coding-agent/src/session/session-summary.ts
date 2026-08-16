import type { AgentMessage, Immutable } from "@coda/agent";
import type { Api, AssistantMessage, UserMessage } from "@coda/ai";
import type { ComposerSubmission } from "./composer-submission.ts";
import type { SessionRecord } from "./records.ts";
import type { SessionDescriptor, SessionSummary, SessionSummaryModel } from "./types.ts";

export const EMPTY_SESSION_TITLE = "New session";

const MAXIMUM_TITLE_CHARACTERS = 240;

/** Projects durable records into the same summary shape regardless of Provider protocol. */
export function summarizeSessionRecords(
	descriptor: SessionDescriptor,
	records: readonly SessionRecord[],
): SessionSummary {
	const messages: AgentMessage[] = [];
	const submissions = new Map<string, ComposerSubmission>();
	let updatedAt = descriptor.createdAt;
	let model: SessionSummaryModel | undefined;

	for (const record of records) {
		updatedAt = Math.max(updatedAt, record.timestamp);
		switch (record.type) {
			case "message_committed": {
				const message = record.payload.message;
				messages.push(message);
				if (message.message.role === "assistant") model = modelFromAssistant(message.message);
				break;
			}
			case "model_selected": {
				const selected = record.payload.model;
				model = {
					...selected,
					...(model?.provider === selected.provider && model.id === selected.id && model.api
						? { api: model.api }
						: {}),
				};
				break;
			}
			case "composer_submission_recorded":
				submissions.set(record.payload.submission.id, record.payload.submission);
				break;
			case "composer_submission_retracted":
				submissions.delete(record.payload.id);
				break;
			default:
				break;
		}
	}

	return summarizeSessionMessages(descriptor, messages, [...submissions.values()], {
		updatedAt,
		model,
	});
}

/** Builds a live summary for an open in-memory pane that may not exist in the durable listing. */
export function summarizeSessionMessages(
	descriptor: SessionDescriptor,
	messages: readonly AgentMessage[],
	composerSubmissions: readonly ComposerSubmission[] = [],
	overrides: { readonly updatedAt?: number; readonly model?: SessionSummaryModel } = {},
): SessionSummary {
	let updatedAt = overrides.updatedAt ?? descriptor.createdAt;
	let firstUserTitle: string | undefined;
	let promptCount = 0;
	let observedModel: SessionSummaryModel | undefined;

	for (const { message } of messages) {
		updatedAt = Math.max(updatedAt, message.timestamp);
		if (message.role === "user") {
			promptCount++;
			firstUserTitle ??= titleFromContent(message.content);
		} else if (message.role === "assistant") {
			observedModel = modelFromAssistant(message);
		}
	}

	const submissionTitles = composerSubmissions.map(({ text }) => normalizeTitle(text)).filter(isPresent);
	const model = overrides.model ?? observedModel;
	return Object.freeze({
		descriptor: structuredClone(descriptor),
		title: submissionTitles[0] ?? firstUserTitle ?? EMPTY_SESSION_TITLE,
		updatedAt,
		promptCount: Math.max(promptCount, composerSubmissions.length),
		...(model ? { model: Object.freeze({ ...model }) } : {}),
	});
}

function modelFromAssistant(message: Immutable<AssistantMessage>): SessionSummaryModel {
	return Object.freeze({
		provider: message.provider,
		id: message.model,
		api: message.api as Api,
	});
}

function titleFromContent(content: Immutable<UserMessage["content"]>): string | undefined {
	const text =
		typeof content === "string"
			? content
			: content
					.filter((block) => block.type === "text")
					.map((block) => block.text)
					.join(" ");
	return normalizeTitle(text);
}

function normalizeTitle(value: string): string | undefined {
	const normalized = Array.from(value, replaceControlCharacter).join("").replace(/\s+/gu, " ").trim();
	if (!normalized) return undefined;
	const characters = Array.from(normalized);
	if (characters.length <= MAXIMUM_TITLE_CHARACTERS) return normalized;
	return `${characters.slice(0, MAXIMUM_TITLE_CHARACTERS - 1).join("")}…`;
}

function replaceControlCharacter(character: string): string {
	const codePoint = character.codePointAt(0) ?? 0;
	return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) ? " " : character;
}

function isPresent(value: string | undefined): value is string {
	return value !== undefined;
}
