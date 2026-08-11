import type { ToolExecutionOutput } from "@coda/agent";

export function toolFailure<TDetails extends Record<string, unknown>>(
	content: string,
	details: TDetails,
): ToolExecutionOutput<TDetails & { readonly status: "failed" }> {
	return {
		content,
		details: { ...details, status: "failed" },
		isError: true,
	};
}
