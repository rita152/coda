export type InteractiveTerminationSignal = "SIGHUP" | "SIGTERM";

export interface InteractiveLifecycleHandlers {
	readonly terminate: (signal: InteractiveTerminationSignal) => void;
	readonly suspend: () => void;
	readonly fatal: (error: unknown) => void;
}

export interface InteractiveProcessLifecycle {
	subscribe(handlers: InteractiveLifecycleHandlers): () => void;
	suspend(): Promise<void>;
}

export class InteractiveTerminationError extends Error {
	readonly signal: InteractiveTerminationSignal;
	readonly exitCode: number;

	constructor(signal: InteractiveTerminationSignal) {
		super(`Interactive process received ${signal}`);
		this.name = "InteractiveTerminationError";
		this.signal = signal;
		this.exitCode = interactiveSignalExitCode(signal);
	}
}

export function interactiveSignalExitCode(signal: InteractiveTerminationSignal): number {
	return signal === "SIGTERM" ? 143 : 129;
}
