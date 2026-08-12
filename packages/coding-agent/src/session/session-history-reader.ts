import { createHash } from "node:crypto";
import type { AgentMessage } from "@coda/agent";
import { resolveToolObservation, type ToolObservation } from "@coda/ai";

export const SESSION_HISTORY_DEFAULT_LIMIT = 8;
export const SESSION_HISTORY_MAX_LIMIT = 20;
export const SESSION_HISTORY_CURSOR_MAX_LENGTH = 512;
export const SESSION_HISTORY_OUTPUT_LIMIT_BYTES = 256 * 1024;

const MESSAGE_CONTENT_LIMIT_BYTES = 12 * 1024;
const CONTENT_BLOCK_LIMIT = 32;
const IDENTITY_LIMIT_BYTES = 1_024;
const LABEL_LIMIT_BYTES = 512;
const CURSOR_VERSION = 1;

export interface SessionHistoryReadRequest {
	readonly cursor?: string;
	readonly limit?: number;
}

export interface SessionHistoryTextContent {
	readonly type: "text";
	readonly text: string;
}

export interface SessionHistoryImageContent {
	readonly type: "image";
	readonly mimeType: string;
	readonly dataOmitted: true;
}

export interface SessionHistorySkillContent {
	readonly type: "skill";
	readonly name: string;
	readonly pathOmitted: true;
}

export interface SessionHistoryThinkingContent {
	readonly type: "thinking";
	readonly thinkingOmitted: true;
	readonly redacted: boolean;
}

export interface SessionHistoryToolCallContent {
	readonly type: "toolCall";
	readonly id: string;
	readonly name: string;
	readonly argumentsOmitted: true;
}

export type SessionHistoryContent =
	| SessionHistoryTextContent
	| SessionHistoryImageContent
	| SessionHistorySkillContent
	| SessionHistoryThinkingContent
	| SessionHistoryToolCallContent;

interface SessionHistoryMessageBase {
	readonly id: string;
	readonly timestamp: number;
	readonly content: readonly SessionHistoryContent[];
	/** True only for the history projection; Tool Observation truncation remains independent. */
	readonly contentTruncated: boolean;
}

export interface SessionHistoryUserMessage extends SessionHistoryMessageBase {
	readonly role: "user";
}

export interface SessionHistoryAssistantMessage extends SessionHistoryMessageBase {
	readonly role: "assistant";
}

export interface SessionHistoryToolResultMessage extends SessionHistoryMessageBase {
	readonly role: "toolResult";
	readonly toolCallId: string;
	readonly toolName: string;
	readonly observation: ToolObservation;
}

export type SessionHistoryMessage =
	| SessionHistoryUserMessage
	| SessionHistoryAssistantMessage
	| SessionHistoryToolResultMessage;

export interface SessionHistoryPage {
	readonly version: 1;
	readonly order: "chronological";
	readonly messages: readonly SessionHistoryMessage[];
	readonly hasMoreBefore: boolean;
	readonly nextCursor?: string;
}

export interface SessionHistoryReadPort {
	read(request?: SessionHistoryReadRequest): SessionHistoryPage;
}

export type SessionHistoryCursorErrorCode = "malformed_cursor" | "stale_cursor";

export class SessionHistoryCursorError extends Error {
	readonly code: SessionHistoryCursorErrorCode;

	constructor(code: SessionHistoryCursorErrorCode, message: string) {
		super(message);
		this.name = "SessionHistoryCursorError";
		this.code = code;
	}
}

interface SessionHistoryCursorV1 {
	readonly v: 1;
	readonly session: string;
	readonly tail: string;
	readonly before: string;
}

export interface SessionHistoryReaderOptions {
	readonly sessionId: string;
	/** Returns the complete committed Message projection in append order. */
	readonly messages: () => readonly AgentMessage[];
}

/**
 * Projects the append-only Session transcript through one bounded read seam.
 *
 * The reader never receives Session Records or persistence metadata. Its cursor
 * fixes a transcript tail and an exclusive Message boundary, so later appends
 * cannot reorder an existing pagination traversal.
 */
export class SessionHistoryReader implements SessionHistoryReadPort {
	readonly #messages: () => readonly AgentMessage[];
	readonly #sessionDigest: string;

	constructor(options: SessionHistoryReaderOptions) {
		if (!options.sessionId) throw new Error("SessionHistoryReader requires a Session identity");
		this.#messages = options.messages;
		this.#sessionDigest = digest(options.sessionId);
	}

	read(request: SessionHistoryReadRequest = {}): SessionHistoryPage {
		const limit = request.limit ?? SESSION_HISTORY_DEFAULT_LIMIT;
		if (!Number.isInteger(limit) || limit < 1 || limit > SESSION_HISTORY_MAX_LIMIT) {
			throw new RangeError(`Session history limit must be between 1 and ${SESSION_HISTORY_MAX_LIMIT}`);
		}
		const messages = structuredClone(this.#messages());
		const locations = messageLocations(messages);
		let end = messages.length;
		let snapshotTailDigest: string | undefined;

		if (request.cursor !== undefined) {
			const cursor = decodeCursor(request.cursor);
			if (cursor.session !== this.#sessionDigest) {
				throw new SessionHistoryCursorError("stale_cursor", "Session history cursor belongs to another Session");
			}
			const tail = locationForDigest(locations, cursor.tail);
			const before = locationForDigest(locations, cursor.before);
			if (tail === undefined || before === undefined || before > tail) {
				throw new SessionHistoryCursorError(
					"stale_cursor",
					"Session history cursor no longer matches this transcript",
				);
			}
			end = before;
			snapshotTailDigest = cursor.tail;
		} else if (messages.length > 0) {
			snapshotTailDigest = digest(messages.at(-1)!.id);
		}

		const start = Math.max(0, end - limit);
		const projected = messages.slice(start, end).map(projectMessage);
		const hasMoreBefore = start > 0;
		const nextCursor =
			hasMoreBefore && snapshotTailDigest
				? encodeCursor({
						v: CURSOR_VERSION,
						session: this.#sessionDigest,
						tail: snapshotTailDigest,
						before: digest(messages[start]!.id),
					})
				: undefined;
		const page: SessionHistoryPage = {
			version: 1,
			order: "chronological",
			messages: projected,
			hasMoreBefore,
			...(nextCursor ? { nextCursor } : {}),
		};
		return enforcePageBound(page);
	}
}

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function messageLocations(messages: readonly AgentMessage[]): ReadonlyMap<string, number> {
	const locations = new Map<string, number>();
	for (let index = 0; index < messages.length; index++) {
		const id = messages[index]?.id;
		if (typeof id !== "string" || id.length === 0)
			throw new Error("Session history contains an invalid Message identity");
		const key = digest(id);
		if (locations.has(key)) throw new Error("Session history contains duplicate Message identities");
		locations.set(key, index);
	}
	return locations;
}

function locationForDigest(locations: ReadonlyMap<string, number>, value: string): number | undefined {
	return locations.get(value);
}

function encodeCursor(cursor: SessionHistoryCursorV1): string {
	const encoded = Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
	if (encoded.length > SESSION_HISTORY_CURSOR_MAX_LENGTH) {
		throw new Error("Session history cursor exceeded its output bound");
	}
	return encoded;
}

function decodeCursor(value: string): SessionHistoryCursorV1 {
	if (value.length < 1 || value.length > SESSION_HISTORY_CURSOR_MAX_LENGTH || !/^[A-Za-z0-9_-]+$/u.test(value)) {
		throw malformedCursor();
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
	} catch {
		throw malformedCursor();
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw malformedCursor();
	const cursor = parsed as Record<string, unknown>;
	if (
		Object.keys(cursor).sort().join(",") !== "before,session,tail,v" ||
		cursor.v !== CURSOR_VERSION ||
		!isDigest(cursor.session) ||
		!isDigest(cursor.tail) ||
		!isDigest(cursor.before)
	) {
		throw malformedCursor();
	}
	return cursor as unknown as SessionHistoryCursorV1;
}

function malformedCursor(): SessionHistoryCursorError {
	return new SessionHistoryCursorError("malformed_cursor", "Session history cursor is malformed");
}

function isDigest(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function projectMessage(message: AgentMessage): SessionHistoryMessage {
	const id = boundedIdentity(message.id);
	const timestamp = Number.isFinite(message.message.timestamp) ? message.message.timestamp : 0;
	if (message.message.role === "user") {
		const projected = projectUserContent(message.message.content);
		return {
			id,
			role: "user",
			timestamp,
			content: projected.content,
			contentTruncated: projected.truncated,
		};
	}
	if (message.message.role === "assistant") {
		const projected = projectAssistantContent(message.message.content);
		return {
			id,
			role: "assistant",
			timestamp,
			content: projected.content,
			contentTruncated: projected.truncated,
		};
	}
	const projected = projectToolResultContent(message.message.content);
	return {
		id,
		role: "toolResult",
		timestamp,
		toolCallId: boundedIdentity(message.message.toolCallId),
		toolName: boundedLabel(message.message.toolName),
		content: projected.content,
		contentTruncated: projected.truncated,
		observation: resolveToolObservation(message.message),
	};
}

function projectUserContent(content: Extract<AgentMessage["message"], { role: "user" }>["content"]): ProjectedContent {
	if (typeof content === "string") return projectBlocks([{ type: "text", text: content }]);
	return projectBlocks(
		content.map((block) => {
			if (block.type === "text") return { type: "text" as const, text: block.text };
			if (block.type === "image") {
				return { type: "image" as const, mimeType: boundedLabel(block.mimeType), dataOmitted: true as const };
			}
			return { type: "skill" as const, name: boundedLabel(block.name), pathOmitted: true as const };
		}),
		content.some((block) => block.type !== "text"),
	);
}

function projectAssistantContent(
	content: Extract<AgentMessage["message"], { role: "assistant" }>["content"],
): ProjectedContent {
	return projectBlocks(
		content.map((block) => {
			if (block.type === "text") return { type: "text" as const, text: block.text };
			if (block.type === "thinking") {
				return {
					type: "thinking" as const,
					thinkingOmitted: true as const,
					redacted: block.redacted === true,
				};
			}
			return {
				type: "toolCall" as const,
				id: boundedIdentity(block.id),
				name: boundedLabel(block.name),
				argumentsOmitted: true as const,
			};
		}),
		content.some((block) => block.type !== "text"),
	);
}

function projectToolResultContent(
	content: Extract<AgentMessage["message"], { role: "toolResult" }>["content"],
): ProjectedContent {
	return projectBlocks(
		content.map((block) =>
			block.type === "text"
				? { type: "text" as const, text: block.text }
				: { type: "image" as const, mimeType: boundedLabel(block.mimeType), dataOmitted: true as const },
		),
		content.some((block) => block.type !== "text"),
	);
}

interface ProjectedContent {
	readonly content: readonly SessionHistoryContent[];
	readonly truncated: boolean;
}

function projectBlocks(blocks: readonly SessionHistoryContent[], alreadyTruncated = false): ProjectedContent {
	const content: SessionHistoryContent[] = [];
	let used = 2;
	let truncated = alreadyTruncated;
	for (let index = 0; index < blocks.length; index++) {
		if (index >= CONTENT_BLOCK_LIMIT) {
			truncated = true;
			break;
		}
		const block = blocks[index]!;
		const separatorBytes = content.length > 0 ? 1 : 0;
		const remaining = MESSAGE_CONTENT_LIMIT_BYTES - used - separatorBytes;
		if (remaining <= 0) {
			truncated = true;
			break;
		}
		const fitted = fitBlock(block, remaining);
		if (!fitted.block) {
			truncated = true;
			break;
		}
		content.push(fitted.block);
		used += separatorBytes + jsonBytes(fitted.block);
		truncated ||= fitted.truncated;
	}
	if (content.length < blocks.length) truncated = true;
	return { content, truncated };
}

function fitBlock(
	block: SessionHistoryContent,
	maximumBytes: number,
): { readonly block?: SessionHistoryContent; readonly truncated: boolean } {
	if (jsonBytes(block) <= maximumBytes) return { block, truncated: false };
	if (block.type !== "text") return { truncated: true };
	const overhead = jsonBytes({ type: "text", text: "" });
	if (maximumBytes <= overhead) return { truncated: true };
	const fitted = truncateJsonString(block.text, maximumBytes - overhead);
	return { block: { type: "text", text: fitted.value }, truncated: fitted.truncated };
}

function boundedIdentity(value: string): string {
	if (jsonBytes(value) <= IDENTITY_LIMIT_BYTES) return value;
	return `sha256:${digest(value)}`;
}

function boundedLabel(value: string): string {
	if (jsonBytes(value) <= LABEL_LIMIT_BYTES) return value;
	const suffix = `…#${digest(value).slice(0, 16)}`;
	const fitted = truncateJsonString(value, Math.max(16, LABEL_LIMIT_BYTES - jsonBytes(suffix)));
	return `${fitted.value}${suffix}`;
}

function truncateJsonString(
	value: string,
	maximumBytes: number,
): { readonly value: string; readonly truncated: boolean } {
	if (jsonBytes(value) <= maximumBytes) return { value, truncated: false };
	let low = 0;
	let high = value.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		const candidate = safeSlice(value, middle);
		if (jsonBytes(candidate) <= maximumBytes) low = middle;
		else high = middle - 1;
	}
	return { value: safeSlice(value, low), truncated: true };
}

function safeSlice(value: string, end: number): string {
	let boundary = Math.min(value.length, Math.max(0, end));
	if (boundary > 0 && boundary < value.length && /[\uD800-\uDBFF]/u.test(value[boundary - 1]!)) boundary--;
	return value.slice(0, boundary);
}

function enforcePageBound(page: SessionHistoryPage): SessionHistoryPage {
	if (jsonBytes(page) <= SESSION_HISTORY_OUTPUT_LIMIT_BYTES) return page;
	const messages = page.messages.map((message) => ({
		...message,
		content: Object.freeze([]),
		contentTruncated: true,
	}));
	const bounded = { ...page, messages };
	if (jsonBytes(bounded) > SESSION_HISTORY_OUTPUT_LIMIT_BYTES) {
		throw new Error("Session history metadata exceeded its output bound");
	}
	return bounded;
}

function jsonBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}
