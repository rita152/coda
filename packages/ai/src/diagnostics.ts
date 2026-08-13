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

export function createStreamDiagnostic(
	model: Model,
	error: unknown,
	options: StreamDiagnosticOptions,
): AssistantMessageDiagnostic {
	const candidate = error instanceof Error ? error : new Error(String(error));
	const metadata = candidate as Error & { code?: unknown; status?: unknown; retryable?: unknown };
	const status = typeof metadata.status === "number" ? metadata.status : null;
	const providerCode =
		typeof metadata.code === "string" || typeof metadata.code === "number" ? metadata.code : undefined;
	const contextOverflow = isContextOverflow(candidate, providerCode);
	const code = contextOverflow ? "context_overflow" : providerCode;
	const retryableStatus =
		status !== null && (status === 408 || status === 409 || status === 429 || (status >= 500 && status <= 599));
	const retryable =
		!contextOverflow &&
		metadata.retryable !== false &&
		(metadata.retryable === true || retryableStatus || isRetryableTransportError(candidate, code));
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
			retryable,
			...(contextOverflow && providerCode !== undefined ? { providerCode } : {}),
		},
	};
}
