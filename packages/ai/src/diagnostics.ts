import type { Clock, Model } from "./types.ts";

export interface DiagnosticErrorInfo {
	name?: string;
	message: string;
	stack?: string;
	code?: string | number;
}

export interface AssistantMessageDiagnostic {
	type: string;
	timestamp: number;
	error?: DiagnosticErrorInfo;
	details?: Record<string, unknown>;
}

export interface StreamDiagnosticOptions {
	phase: string;
	clock: Clock;
	debug?: boolean;
}

export type ModelFailurePhase = "request" | "stream";
export type ModelFailureCategory =
	| "transport"
	| "rate_limit"
	| "provider"
	| "context_overflow"
	| "protocol"
	| "unknown";
export type ModelFailureRetryability = "retryable" | "non_retryable" | "unknown";

/** Provider-neutral failure semantics. AI owns this classification; callers own retry policy. */
export interface NormalizedModelFailure {
	readonly phase: ModelFailurePhase;
	readonly category: ModelFailureCategory;
	readonly retryability: ModelFailureRetryability;
	readonly providerCode?: string | number;
	readonly httpStatus?: number;
}

export interface NormalizeModelFailureOptions {
	readonly phase: string;
	readonly retryabilityOverride?: boolean;
	/** Request establishment errors with no status are Provider transport failures. */
	readonly providerRequest?: boolean;
}

const RETRYABLE_TRANSPORT_CODES = new Set([
	"ECONNABORTED",
	"ECONNREFUSED",
	"ECONNRESET",
	"EHOSTUNREACH",
	"ENETDOWN",
	"ENETRESET",
	"ENETUNREACH",
	"ENOTFOUND",
	"EPIPE",
	"ETIMEDOUT",
]);

const CONTEXT_OVERFLOW_CODES = new Set([
	"context_length_exceeded",
	"context_limit_exceeded",
	"context_window_exceeded",
	"prompt_too_long",
	"token_limit_exceeded",
]);

const NON_RETRYABLE_PROVIDER_CODES = new Set(["auth", "billing", "invalid_request", "oauth", "quota", "validation"]);

const PROTOCOL_CODES = new Set(["EPROTO", "ERR_INVALID_RESPONSE", "PROTOCOL_ERROR"]);

function isContextOverflow(error: Error, code: string | number | undefined): boolean {
	if (typeof code === "string" && CONTEXT_OVERFLOW_CODES.has(code.toLowerCase())) return true;
	const message = error.message.toLowerCase();
	return (
		(message.includes("context length") || message.includes("context window")) &&
		(message.includes("exceed") || message.includes("too long") || message.includes("maximum"))
	);
}

function isRetryableTransportError(error: Error, code: string | number | undefined): boolean {
	if (typeof code === "string" && RETRYABLE_TRANSPORT_CODES.has(code.toUpperCase())) return true;
	return (
		error.name === "APIConnectionError" || error.name === "APIConnectionTimeoutError" || error.name === "TimeoutError"
	);
}

function normalizedPhase(phase: string): ModelFailurePhase {
	return phase === "stream" ? "stream" : "request";
}

export function normalizeModelFailure(error: unknown, options: NormalizeModelFailureOptions): NormalizedModelFailure {
	const candidate = error instanceof Error ? error : new Error(String(error));
	const metadata = candidate as Error & { code?: unknown; status?: unknown; retryable?: unknown };
	const status = typeof metadata.status === "number" ? metadata.status : undefined;
	const providerCode =
		typeof metadata.code === "string" || typeof metadata.code === "number" ? metadata.code : undefined;
	const normalizedCode = typeof providerCode === "string" ? providerCode.toLowerCase() : undefined;
	const contextOverflow = isContextOverflow(candidate, providerCode);
	const transport = isRetryableTransportError(candidate, providerCode);
	const protocol = typeof providerCode === "string" && PROTOCOL_CODES.has(providerCode.toUpperCase());
	const rateLimit =
		status === 429 ||
		normalizedCode === "rate_limit" ||
		normalizedCode === "rate_limit_error" ||
		normalizedCode === "rate_limit_exceeded";
	const category: ModelFailureCategory = contextOverflow
		? "context_overflow"
		: rateLimit
			? "rate_limit"
			: protocol
				? "protocol"
				: transport
					? "transport"
					: status !== undefined || options.providerRequest
						? "provider"
						: "unknown";

	let retryability: ModelFailureRetryability;
	if (contextOverflow || (normalizedCode !== undefined && NON_RETRYABLE_PROVIDER_CODES.has(normalizedCode))) {
		retryability = "non_retryable";
	} else if (options.retryabilityOverride !== undefined) {
		retryability = options.retryabilityOverride ? "retryable" : "non_retryable";
	} else if (typeof metadata.retryable === "boolean") {
		retryability = metadata.retryable ? "retryable" : "non_retryable";
	} else if (
		transport ||
		rateLimit ||
		status === 408 ||
		status === 409 ||
		(status !== undefined && status >= 500 && status <= 599) ||
		(options.providerRequest && status === undefined)
	) {
		retryability = "retryable";
	} else if (status !== undefined) {
		retryability = "non_retryable";
	} else {
		retryability = "unknown";
	}

	return {
		phase: normalizedPhase(options.phase),
		category,
		retryability,
		...(providerCode !== undefined ? { providerCode } : {}),
		...(status !== undefined ? { httpStatus: status } : {}),
	};
}

export function createStreamDiagnostic(
	model: Model,
	error: unknown,
	options: StreamDiagnosticOptions,
): AssistantMessageDiagnostic {
	const candidate = error instanceof Error ? error : new Error(String(error));
	const failure = normalizeModelFailure(candidate, { phase: options.phase });
	const status = failure.httpStatus ?? null;
	const code = failure.category === "context_overflow" ? "context_overflow" : failure.providerCode;
	const errorInfo: DiagnosticErrorInfo = { name: candidate.name, message: candidate.message, code };
	if (options.debug && candidate.stack) errorInfo.stack = candidate.stack;
	return {
		type: "stream_error",
		timestamp: options.clock.now(),
		error: errorInfo,
		details: {
			phase: options.phase,
			provider: model.provider,
			api: model.api,
			status,
			retryable: failure.retryability === "retryable",
			failure,
			...(failure.category === "context_overflow" && failure.providerCode !== undefined
				? { providerCode: failure.providerCode }
				: {}),
		},
	};
}
