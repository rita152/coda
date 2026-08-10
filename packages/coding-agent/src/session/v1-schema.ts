import type { SessionHeader, SessionRecordType } from "./records.ts";

type JsonRecord = Record<string, unknown>;
type SessionFormatVersion = 1 | 2 | 3 | 4 | 5 | 6;

export interface ValidSessionRecordEnvelope extends JsonRecord {
	readonly type: string;
	readonly recordId: string;
	readonly sessionId: string;
	readonly sequence: number;
	readonly previousRecordId: string | null;
	readonly timestamp: number;
	readonly payload: unknown;
	readonly runId?: string;
	readonly turnId?: string;
	readonly attemptId?: string;
}

const STOP_REASONS = new Set(["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"]);
const REASONING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const RUN_OUTCOMES = new Set(["success", "error", "aborted"]);
const TOOL_OUTCOMES = new Set(["success", "error", "aborted", "rejected", "interrupted"]);
const TOOL_REASONS = new Set(["missing", "invalid", "policy", "aborted", "not_started", "skipped_by_user"]);

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactRecord(
	value: unknown,
	required: readonly string[],
	optional: readonly string[] = [],
): value is JsonRecord {
	if (!isRecord(value)) return false;
	const allowed = new Set([...required, ...optional]);
	return required.every((key) => key in value) && Object.keys(value).every((key) => allowed.has(key));
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPositiveInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) > 0;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isComposerExtensionReferences(value: unknown, text: string): boolean {
	if (!Array.isArray(value) || value.length === 0) return false;
	const identities = new Set<string>();
	let previousEnd = 0;
	for (const reference of value) {
		if (
			!exactRecord(reference, ["id", "commandId", "source", "name", "start", "end"]) ||
			!isNonEmptyString(reference.id) ||
			identities.has(reference.id) ||
			!isNonEmptyString(reference.commandId) ||
			(reference.source !== "skill" && reference.source !== "mcp") ||
			!isNonEmptyString(reference.name) ||
			/[\s/]/u.test(reference.name) ||
			!isNonNegativeInteger(reference.start) ||
			!isNonNegativeInteger(reference.end) ||
			reference.start < previousEnd ||
			reference.start >= reference.end ||
			reference.end > text.length ||
			!reference.commandId.startsWith(`${reference.source}:`) ||
			reference.commandId.length <= reference.source.length + 1 ||
			text.slice(reference.start, reference.end) !== `/${reference.name}`
		) {
			return false;
		}
		identities.add(reference.id);
		previousEnd = reference.end;
	}
	return true;
}

function isJsonValue(value: unknown): boolean {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isJsonValue);
	return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isPermissionPolicySnapshot(value: unknown): boolean {
	return (
		exactRecord(value, [
			"profile",
			"readAccess",
			"deniedReadRoots",
			"writableRoots",
			"protectedMetadataRoots",
			"protectedMetadataNames",
			"protectedMetadataPaths",
			"networkAccess",
		]) &&
		(value.profile === "read-only" || value.profile === "workspace" || value.profile === "full-access") &&
		value.readAccess === "full-disk" &&
		isStringArray(value.deniedReadRoots) &&
		(value.writableRoots === "full-disk" || isStringArray(value.writableRoots)) &&
		isStringArray(value.protectedMetadataRoots) &&
		isStringArray(value.protectedMetadataNames) &&
		isStringArray(value.protectedMetadataPaths) &&
		(value.networkAccess === "restricted" || value.networkAccess === "enabled")
	);
}

function isApprovalPolicy(value: unknown): boolean {
	return (
		value === "unless-trusted" ||
		value === "on-request" ||
		value === "never" ||
		(exactRecord(value, [
			"mode",
			"sandboxApproval",
			"rules",
			"skillApproval",
			"requestPermissions",
			"mcpElicitations",
		]) &&
			value.mode === "granular" &&
			["sandboxApproval", "rules", "skillApproval", "requestPermissions", "mcpElicitations"].every(
				(key) => typeof value[key] === "boolean",
			))
	);
}

function isPermissionAuditEvent(value: unknown): boolean {
	if (!isRecord(value) || typeof value.type !== "string") return false;
	switch (value.type) {
		case "configuration":
			return (
				exactRecord(value, ["type", "source", "approvalPolicy", "policy"]) &&
				(value.source === "startup" || value.source === "permissions-command") &&
				isApprovalPolicy(value.approvalPolicy) &&
				isPermissionPolicySnapshot(value.policy)
			);
		case "approval_decision":
			return (
				(exactRecord(value, ["type", "invocationId", "kind", "outcome"], ["commandPrefix", "denial"]) &&
					isNonEmptyString(value.invocationId) &&
					["command", "filesystem", "network", "skill", "mcp"].includes(String(value.kind)) &&
					[
						"approved-once",
						"approved-for-process",
						"allowed-by-process",
						"denied",
						"aborted",
						"timed-out",
						"persistent-rule",
						"reviewer-failed",
					].includes(String(value.outcome)) &&
					(value.commandPrefix === undefined ||
						(Array.isArray(value.commandPrefix) &&
							value.commandPrefix.length > 0 &&
							value.commandPrefix.every(isNonEmptyString))) &&
					(value.denial === undefined ||
						(exactRecord(value.denial, ["type", "characterCount", "summary"]) &&
							["plain", "feedback", "reviewer-failed"].includes(String(value.denial.type)) &&
							Number.isSafeInteger(value.denial.characterCount) &&
							Number(value.denial.characterCount) >= 0 &&
							typeof value.denial.summary === "string" &&
							Array.from(value.denial.summary).length <= 160))) ||
				(exactRecord(value, ["type", "request", "decision"]) &&
					isRecord(value.request) &&
					isJsonValue(value.request) &&
					isRecord(value.decision) &&
					isNonEmptyString(value.decision.type) &&
					isJsonValue(value.decision))
			);
		case "rule_persistence":
			return (
				exactRecord(value, ["type", "kind", "rule", "outcome"], ["error"]) &&
				(value.kind === "command" || value.kind === "network") &&
				isRecord(value.rule) &&
				isJsonValue(value.rule) &&
				(value.outcome === "persisted" || value.outcome === "failed") &&
				(value.error === undefined || typeof value.error === "string")
			);
		case "warning":
			return exactRecord(value, ["type", "message"]) && isNonEmptyString(value.message);
		case "sandbox_execution":
			return (
				exactRecord(
					value,
					["type", "invocationId", "toolName", "policy", "outcome"],
					["backend", "exitCode", "signal", "denial", "error"],
				) &&
				isNonEmptyString(value.invocationId) &&
				isNonEmptyString(value.toolName) &&
				isPermissionPolicySnapshot(value.policy) &&
				["success", "normal-failure", "sandbox-denial", "timed-out", "cancelled", "launch-failed"].includes(
					String(value.outcome),
				) &&
				(value.backend === undefined ||
					value.backend === "none" ||
					value.backend === "macos-seatbelt" ||
					value.backend === "linux-bwrap") &&
				(value.exitCode === undefined || value.exitCode === null || Number.isSafeInteger(value.exitCode)) &&
				(value.signal === undefined || value.signal === null || typeof value.signal === "string") &&
				(value.denial === undefined || isJsonValue(value.denial)) &&
				(value.error === undefined || typeof value.error === "string")
			);
		default:
			return false;
	}
}

function isTextContent(value: unknown): boolean {
	return (
		exactRecord(value, ["type", "text"], ["textSignature"]) &&
		value.type === "text" &&
		typeof value.text === "string" &&
		(value.textSignature === undefined || typeof value.textSignature === "string")
	);
}

function isImageContent(value: unknown): boolean {
	return (
		exactRecord(value, ["type", "data", "mimeType"]) &&
		value.type === "image" &&
		typeof value.data === "string" &&
		isNonEmptyString(value.mimeType)
	);
}

function isMediaReference(value: unknown): boolean {
	return (
		exactRecord(value, ["type", "digest", "filename", "mimeType", "width", "height", "bytes", "rendition"]) &&
		value.type === "media" &&
		typeof value.digest === "string" &&
		/^[a-f0-9]{64}$/.test(value.digest) &&
		isNonEmptyString(value.filename) &&
		isNonEmptyString(value.mimeType) &&
		isPositiveInteger(value.width) &&
		isPositiveInteger(value.height) &&
		isPositiveInteger(value.bytes) &&
		exactRecord(value.rendition, ["digest", "mimeType", "width", "height", "bytes"]) &&
		typeof value.rendition.digest === "string" &&
		/^[a-f0-9]{64}$/.test(value.rendition.digest) &&
		isNonEmptyString(value.rendition.mimeType) &&
		isPositiveInteger(value.rendition.width) &&
		isPositiveInteger(value.rendition.height) &&
		isPositiveInteger(value.rendition.bytes)
	);
}

function isThinkingContent(value: unknown): boolean {
	return (
		exactRecord(value, ["type", "thinking"], ["thinkingSignature", "redacted"]) &&
		value.type === "thinking" &&
		typeof value.thinking === "string" &&
		(value.thinkingSignature === undefined || typeof value.thinkingSignature === "string") &&
		(value.redacted === undefined || typeof value.redacted === "boolean")
	);
}

function isToolCall(value: unknown): boolean {
	return (
		exactRecord(value, ["type", "id", "name", "arguments"], ["thoughtSignature"]) &&
		value.type === "toolCall" &&
		isNonEmptyString(value.id) &&
		isNonEmptyString(value.name) &&
		isRecord(value.arguments) &&
		isJsonValue(value.arguments) &&
		(value.thoughtSignature === undefined || typeof value.thoughtSignature === "string")
	);
}

function isUsageCost(value: unknown): boolean {
	return (
		exactRecord(value, ["input", "output", "cacheRead", "cacheWrite", "total"]) &&
		isFiniteNumber(value.input) &&
		isFiniteNumber(value.output) &&
		isFiniteNumber(value.cacheRead) &&
		isFiniteNumber(value.cacheWrite) &&
		isFiniteNumber(value.total)
	);
}

function isUsage(value: unknown): boolean {
	return (
		exactRecord(
			value,
			["input", "output", "cacheRead", "cacheWrite", "totalTokens"],
			["cacheWrite1h", "reasoning", "cost"],
		) &&
		isFiniteNumber(value.input) &&
		isFiniteNumber(value.output) &&
		isFiniteNumber(value.cacheRead) &&
		isFiniteNumber(value.cacheWrite) &&
		isFiniteNumber(value.totalTokens) &&
		(value.cacheWrite1h === undefined || isFiniteNumber(value.cacheWrite1h)) &&
		(value.reasoning === undefined || isFiniteNumber(value.reasoning)) &&
		(value.cost === undefined || isUsageCost(value.cost))
	);
}

function isDiagnosticError(value: unknown): boolean {
	return (
		exactRecord(value, ["message"], ["name", "code"]) &&
		typeof value.message === "string" &&
		(value.name === undefined || typeof value.name === "string") &&
		(value.code === undefined || typeof value.code === "string" || typeof value.code === "number")
	);
}

function isDiagnostic(value: unknown): boolean {
	return (
		exactRecord(value, ["type", "timestamp"], ["error", "details"]) &&
		isNonEmptyString(value.type) &&
		isFiniteNumber(value.timestamp) &&
		(value.error === undefined || isDiagnosticError(value.error)) &&
		(value.details === undefined || (isRecord(value.details) && isJsonValue(value.details)))
	);
}

function isDeferredHandle(value: unknown): boolean {
	return (
		exactRecord(value, ["provider", "modelId", "api", "id"], ["expiresAt", "pollAfterMs", "data"]) &&
		isNonEmptyString(value.provider) &&
		isNonEmptyString(value.modelId) &&
		isNonEmptyString(value.api) &&
		isNonEmptyString(value.id) &&
		(value.expiresAt === undefined || isFiniteNumber(value.expiresAt)) &&
		(value.pollAfterMs === undefined || isFiniteNumber(value.pollAfterMs)) &&
		(value.data === undefined || isJsonValue(value.data))
	);
}

function isUserMessage(value: unknown, version: SessionFormatVersion): boolean {
	return (
		exactRecord(value, ["role", "content", "timestamp"]) &&
		value.role === "user" &&
		(typeof value.content === "string" ||
			(Array.isArray(value.content) &&
				value.content.every(
					(entry) => isTextContent(entry) || (version === 1 ? isImageContent(entry) : isMediaReference(entry)),
				))) &&
		isFiniteNumber(value.timestamp)
	);
}

function isAssistantMessage(value: unknown): boolean {
	return (
		exactRecord(
			value,
			["role", "content", "api", "provider", "model", "usage", "stopReason", "timestamp"],
			["responseModel", "responseId", "diagnostics", "deferred", "errorMessage", "rawStopReason"],
		) &&
		value.role === "assistant" &&
		Array.isArray(value.content) &&
		value.content.every((entry) => isTextContent(entry) || isThinkingContent(entry) || isToolCall(entry)) &&
		isNonEmptyString(value.api) &&
		isNonEmptyString(value.provider) &&
		isNonEmptyString(value.model) &&
		isUsage(value.usage) &&
		STOP_REASONS.has(String(value.stopReason)) &&
		isFiniteNumber(value.timestamp) &&
		(value.responseModel === undefined || typeof value.responseModel === "string") &&
		(value.responseId === undefined || typeof value.responseId === "string") &&
		(value.diagnostics === undefined ||
			(Array.isArray(value.diagnostics) && value.diagnostics.every(isDiagnostic))) &&
		(value.deferred === undefined || isDeferredHandle(value.deferred)) &&
		(value.errorMessage === undefined || typeof value.errorMessage === "string") &&
		(value.rawStopReason === undefined || typeof value.rawStopReason === "string")
	);
}

function isToolResultMessage(value: unknown, version: SessionFormatVersion): boolean {
	return (
		exactRecord(
			value,
			["role", "toolCallId", "toolName", "content", "isError", "timestamp"],
			["details", "usage", "addedToolNames"],
		) &&
		value.role === "toolResult" &&
		isNonEmptyString(value.toolCallId) &&
		isNonEmptyString(value.toolName) &&
		Array.isArray(value.content) &&
		value.content.every(
			(entry) => isTextContent(entry) || (version === 1 ? isImageContent(entry) : isMediaReference(entry)),
		) &&
		typeof value.isError === "boolean" &&
		isFiniteNumber(value.timestamp) &&
		(value.details === undefined || isJsonValue(value.details)) &&
		(value.usage === undefined || isUsage(value.usage)) &&
		(value.addedToolNames === undefined || isStringArray(value.addedToolNames))
	);
}

function isAgentMessage(value: unknown, version: SessionFormatVersion): boolean {
	return (
		exactRecord(value, ["id", "message"]) &&
		isNonEmptyString(value.id) &&
		(isUserMessage(value.message, version) ||
			isAssistantMessage(value.message) ||
			isToolResultMessage(value.message, version))
	);
}

function isAgentInput(value: unknown, version: SessionFormatVersion): boolean {
	return (
		typeof value === "string" ||
		(Array.isArray(value) &&
			value.every(
				(entry) => isTextContent(entry) || (version === 1 ? isImageContent(entry) : isMediaReference(entry)),
			))
	);
}

function isToolInvocation(value: unknown): boolean {
	return (
		exactRecord(
			value,
			["id", "resultMessageId", "providerToolCallId", "toolName", "arguments", "sourceIndex"],
			["replaySafety"],
		) &&
		isNonEmptyString(value.id) &&
		isNonEmptyString(value.resultMessageId) &&
		isNonEmptyString(value.providerToolCallId) &&
		isNonEmptyString(value.toolName) &&
		isRecord(value.arguments) &&
		isJsonValue(value.arguments) &&
		isNonNegativeInteger(value.sourceIndex) &&
		(value.replaySafety === undefined || value.replaySafety === "never" || value.replaySafety === "safe")
	);
}

function isRunFailure(value: unknown): boolean {
	return (
		exactRecord(value, ["kind", "message"]) &&
		(value.kind === "model" || value.kind === "tool" || value.kind === "runtime" || value.kind === "listener") &&
		typeof value.message === "string"
	);
}

export function isSessionHeader(value: unknown): value is SessionHeader {
	return (
		exactRecord(value, ["type", "version", "sessionId", "workspaceId", "workspacePath", "createdAt"]) &&
		value.type === "session" &&
		(value.version === 1 ||
			value.version === 2 ||
			value.version === 3 ||
			value.version === 4 ||
			value.version === 5 ||
			value.version === 6) &&
		isNonEmptyString(value.sessionId) &&
		isNonEmptyString(value.workspaceId) &&
		isNonEmptyString(value.workspacePath) &&
		isFiniteNumber(value.createdAt)
	);
}

export function isSessionRecordEnvelope(value: unknown): value is ValidSessionRecordEnvelope {
	return (
		exactRecord(
			value,
			["type", "recordId", "sessionId", "sequence", "previousRecordId", "timestamp", "payload"],
			["runId", "turnId", "attemptId"],
		) &&
		isNonEmptyString(value.type) &&
		isNonEmptyString(value.recordId) &&
		isNonEmptyString(value.sessionId) &&
		isPositiveInteger(value.sequence) &&
		(value.previousRecordId === null || isNonEmptyString(value.previousRecordId)) &&
		isFiniteNumber(value.timestamp) &&
		(value.runId === undefined || isNonEmptyString(value.runId)) &&
		(value.turnId === undefined || isNonEmptyString(value.turnId)) &&
		(value.attemptId === undefined || isNonEmptyString(value.attemptId))
	);
}

export function isSessionRecordPayload(
	type: SessionRecordType,
	payload: unknown,
	version: SessionFormatVersion = 1,
): boolean {
	switch (type) {
		case "run_started":
			return (
				exactRecord(payload, ["source"], ["queueItemId", "promptVersion", "promptSha256"]) &&
				(payload.source === "prompt" || payload.source === "follow_up") &&
				(payload.queueItemId === undefined || isNonEmptyString(payload.queueItemId)) &&
				(payload.promptVersion === undefined || isNonEmptyString(payload.promptVersion)) &&
				(payload.promptSha256 === undefined ||
					(typeof payload.promptSha256 === "string" && /^[a-f0-9]{64}$/.test(payload.promptSha256)))
			);
		case "attempt_started":
			return (
				exactRecord(payload, ["messageId", "attempt"]) &&
				isNonEmptyString(payload.messageId) &&
				isPositiveInteger(payload.attempt)
			);
		case "attempt_finished":
			return (
				exactRecord(payload, ["messageId", "attempt", "outcome", "discarded"], ["errorMessage"]) &&
				isNonEmptyString(payload.messageId) &&
				isPositiveInteger(payload.attempt) &&
				RUN_OUTCOMES.has(String(payload.outcome)) &&
				typeof payload.discarded === "boolean" &&
				(payload.errorMessage === undefined || typeof payload.errorMessage === "string")
			);
		case "retry_scheduled":
			return (
				exactRecord(payload, ["attempt", "delayMs", "reason"]) &&
				isPositiveInteger(payload.attempt) &&
				isFiniteNumber(payload.delayMs) &&
				payload.delayMs >= 0 &&
				isNonEmptyString(payload.reason)
			);
		case "message_committed":
			return exactRecord(payload, ["message"]) && isAgentMessage(payload.message, version);
		case "tool_started":
			return exactRecord(payload, ["invocation"]) && isToolInvocation(payload.invocation);
		case "tool_finished": {
			if (
				!exactRecord(payload, ["invocation", "outcome", "resultMessageId"], ["reason"]) ||
				!isToolInvocation(payload.invocation) ||
				!TOOL_OUTCOMES.has(String(payload.outcome)) ||
				!isNonEmptyString(payload.resultMessageId) ||
				(payload.reason !== undefined && !TOOL_REASONS.has(String(payload.reason)))
			) {
				return false;
			}
			if (payload.outcome === "rejected" || payload.outcome === "interrupted") return payload.reason !== undefined;
			return payload.reason === undefined;
		}
		case "turn_finished":
			return exactRecord(payload, ["outcome"]) && RUN_OUTCOMES.has(String(payload.outcome));
		case "run_finished":
			if (exactRecord(payload, ["outcome", "reason"])) {
				return payload.outcome === "interrupted" && payload.reason === "process_ended_before_run_finished";
			}
			return (
				exactRecord(payload, ["outcome"], ["failure"]) &&
				RUN_OUTCOMES.has(String(payload.outcome)) &&
				(payload.failure === undefined || isRunFailure(payload.failure))
			);
		case "follow_up_enqueued":
			return (
				exactRecord(payload, ["item"]) &&
				exactRecord(payload.item, ["id", "content"]) &&
				isNonEmptyString(payload.item.id) &&
				isAgentInput(payload.item.content, version)
			);
		case "follow_up_consumed":
		case "follow_up_canceled":
			return exactRecord(payload, ["id"]) && isNonEmptyString(payload.id);
		case "follow_up_reclaimed":
			return version >= 3 && exactRecord(payload, ["id"]) && isNonEmptyString(payload.id);
		case "composer_submission_recorded":
			if (version < 4 || !exactRecord(payload, ["submission"])) return false;
			if (
				!exactRecord(
					payload.submission,
					["id", "kind", "text"],
					version >= 6 ? ["queueItemId", "references"] : ["queueItemId"],
				)
			) {
				return false;
			}
			return (
				isNonEmptyString(payload.submission.id) &&
				(payload.submission.kind === "prompt" ||
					payload.submission.kind === "steering" ||
					payload.submission.kind === "follow_up") &&
				isNonEmptyString(payload.submission.text) &&
				payload.submission.text.trim().length > 0 &&
				(payload.submission.queueItemId === undefined || isNonEmptyString(payload.submission.queueItemId)) &&
				(payload.submission.references === undefined ||
					(version >= 6 && isComposerExtensionReferences(payload.submission.references, payload.submission.text)))
			);
		case "composer_submission_retracted":
			return version >= 4 && exactRecord(payload, ["id"]) && isNonEmptyString(payload.id);
		case "model_selected":
			return (
				exactRecord(payload, ["model", "reasoning"]) &&
				exactRecord(payload.model, ["provider", "id"]) &&
				isNonEmptyString(payload.model.provider) &&
				isNonEmptyString(payload.model.id) &&
				REASONING_LEVELS.has(String(payload.reasoning))
			);
		case "permission_selected":
			return (
				version >= 6 &&
				exactRecord(payload, ["profile"]) &&
				(payload.profile === "read-only" || payload.profile === "workspace" || payload.profile === "full-access")
			);
		case "project_trust_changed":
			return (
				exactRecord(payload, ["trust"]) &&
				exactRecord(payload.trust, ["workspace", "path", "sha256"]) &&
				isNonEmptyString(payload.trust.workspace) &&
				isNonEmptyString(payload.trust.path) &&
				typeof payload.trust.sha256 === "string" &&
				/^[a-f0-9]{64}$/.test(payload.trust.sha256)
			);
		case "mcp_trust_changed":
			return (
				version >= 6 &&
				exactRecord(payload, ["trust"]) &&
				exactRecord(payload.trust, ["workspace", "path", "sha256"]) &&
				isNonEmptyString(payload.trust.workspace) &&
				isNonEmptyString(payload.trust.path) &&
				typeof payload.trust.sha256 === "string" &&
				/^[a-f0-9]{64}$/.test(payload.trust.sha256)
			);
		case "permission_audit_recorded":
			return version >= 5 && exactRecord(payload, ["event"]) && isPermissionAuditEvent(payload.event);
	}
}
