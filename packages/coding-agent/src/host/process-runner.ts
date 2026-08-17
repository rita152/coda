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
	/** Optional complete stdin payload. The runner closes stdin after writing it. */
	readonly stdin?: string | Uint8Array;
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

export interface ProcessSession {
	readonly completion: Promise<ProcessRunResult>;
	write(input: string | Uint8Array): Promise<void>;
	closeStdin(input?: string | Uint8Array): Promise<void>;
	stop(): Promise<ProcessRunResult>;
}

export interface ProcessSessionRunner {
	start(request: ProcessRunRequest): Promise<ProcessSession>;
}
