export interface ProcessRunRequest {
	readonly executable: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly environment: Readonly<Record<string, string>>;
	readonly signal: AbortSignal;
	readonly timeoutMs: number;
	readonly maxOutputBytes: number;
	readonly maxOutputLines: number;
	readonly overflowPath?: string;
	/** Observes decoded output in the order Node receives data from the two pipes. */
	readonly onOutput?: (chunk: ProcessOutputChunk) => void;
}

export interface ProcessOutputChunk {
	readonly channel: "stdout" | "stderr";
	readonly text: string;
}

export interface ProcessRunResult {
	readonly exitCode: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly timedOut: boolean;
	readonly truncated: boolean;
	readonly overflowPath?: string;
}

export interface ProcessRunner {
	run(request: ProcessRunRequest): Promise<ProcessRunResult>;
}
