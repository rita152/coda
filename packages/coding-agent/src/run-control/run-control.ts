import type { Clock } from "@coda/agent";
import type { ScheduledTask, Scheduler } from "@coda/tui";
import { RunProgressTracker } from "./progress.ts";
import type {
	RunControlConfiguration,
	RunControlPhase,
	RunControlProgressFact,
	RunControlReason,
	RunControlReport,
	RunControlTrigger,
} from "./types.ts";

export interface RunControlOptions {
	readonly configuration: RunControlConfiguration;
	readonly clock: Clock;
	readonly scheduler: Scheduler;
	readonly startedAt?: number;
	readonly requestWrapUp: (trigger: RunControlTrigger) => void;
	readonly hardStop: (reason: "grace_deadline_exceeded") => void;
}

export function validateRunControlConfiguration(
	configuration: RunControlConfiguration,
): Readonly<RunControlConfiguration> {
	const positive = (value: number, name: string): number => {
		if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
		return value;
	};
	const workDurationMs = positive(configuration.workDurationMs, "RunControl workDurationMs");
	const graceDurationMs = positive(configuration.graceDurationMs, "RunControl graceDurationMs");
	const maxStationaryTurns =
		configuration.maxStationaryTurns === undefined
			? undefined
			: positive(configuration.maxStationaryTurns, "RunControl maxStationaryTurns");
	return Object.freeze({ workDurationMs, graceDurationMs, ...(maxStationaryTurns ? { maxStationaryTurns } : {}) });
}

/** Two-phase wall-clock safety envelope, deliberately independent from RunBudget. */
export class RunControl {
	readonly #configuration: Readonly<RunControlConfiguration>;
	readonly #clock: Clock;
	readonly #scheduler: Scheduler;
	readonly #requestWrapUpCallback: RunControlOptions["requestWrapUp"];
	readonly #hardStopCallback: RunControlOptions["hardStop"];
	readonly #startedAt: number;
	readonly #progress = new RunProgressTracker();
	#phase: RunControlPhase = "running";
	#reason: RunControlReason | null = null;
	#trigger: RunControlTrigger | null = null;
	#wrapUpRequestedAt: number | null = null;
	#graceDeadlineAt: number | null = null;
	#finalizingAt: number | null = null;
	#terminalAt: number | null = null;
	#lastProgressAt: number | null = null;
	#workTask?: ScheduledTask;
	#graceTask?: ScheduledTask;

	constructor(options: RunControlOptions) {
		this.#configuration = validateRunControlConfiguration(options.configuration);
		this.#clock = options.clock;
		this.#scheduler = options.scheduler;
		this.#requestWrapUpCallback = options.requestWrapUp;
		this.#hardStopCallback = options.hardStop;
		this.#startedAt = options.startedAt ?? options.clock.now();
		const workDelayMs = Math.max(0, this.#workDeadlineAt() - this.#clock.now());
		this.#workTask = this.#scheduler.schedule(workDelayMs, () => {
			this.#workTask = undefined;
			this.requestWrapUp("work_deadline", this.#clock.now());
		});
	}

	get phase(): RunControlPhase {
		return this.#phase;
	}

	beginTurn(): void {
		this.#progress.beginTurn();
	}

	seedWorkspaceContent(path: string, digest: string): void {
		this.#progress.seedWorkspaceContent(path, digest);
	}

	observe(fact: RunControlProgressFact, timestamp = this.#clock.now()): boolean {
		const progress = this.#progress.observe(fact);
		if (progress) this.#lastProgressAt = timestamp;
		return progress;
	}

	finishTurn(timestamp = this.#clock.now()): number {
		const stationaryTurns = this.#progress.finishTurn();
		if (
			this.#phase === "running" &&
			this.#configuration.maxStationaryTurns !== undefined &&
			stationaryTurns >= this.#configuration.maxStationaryTurns
		) {
			this.requestWrapUp("stagnation", timestamp);
		}
		return stationaryTurns;
	}

	requestWrapUp(trigger: RunControlTrigger, timestamp = this.#clock.now()): boolean {
		if (this.#phase !== "running") return false;
		this.#phase = "wrap_up_requested";
		this.#reason = trigger;
		this.#trigger = trigger;
		this.#wrapUpRequestedAt = timestamp;
		this.#graceDeadlineAt =
			trigger === "work_deadline"
				? this.#workDeadlineAt() + this.#configuration.graceDurationMs
				: timestamp + this.#configuration.graceDurationMs;
		this.#workTask?.cancel();
		this.#workTask = undefined;
		const graceDelayMs = Math.max(0, this.#graceDeadlineAt - this.#clock.now());
		this.#graceTask = this.#scheduler.schedule(graceDelayMs, () => {
			this.#graceTask = undefined;
			this.#reachGraceDeadline(this.#clock.now());
		});
		this.#requestWrapUpCallback(trigger);
		return true;
	}

	markFinalizing(timestamp = this.#clock.now()): boolean {
		if (this.#phase !== "wrap_up_requested") return false;
		this.#phase = "finalizing";
		this.#finalizingAt = timestamp;
		return true;
	}

	complete(timestamp = this.#clock.now()): void {
		this.#cancelTimers();
		if (this.#phase === "terminal") return;
		this.#phase = "terminal";
		this.#reason = "run_ended";
		this.#terminalAt = timestamp;
	}

	dispose(): void {
		this.#cancelTimers();
	}

	report(): RunControlReport {
		const progress = this.#progress.snapshot();
		return deepFreeze({
			schemaVersion: 1 as const,
			phase: this.#phase,
			reason: this.#reason,
			trigger: this.#trigger,
			configured: {
				workDurationMs: this.#configuration.workDurationMs,
				graceDurationMs: this.#configuration.graceDurationMs,
				maxStationaryTurns: this.#configuration.maxStationaryTurns ?? null,
			},
			startedAt: this.#startedAt,
			workDeadlineAt: this.#workDeadlineAt(),
			wrapUpRequestedAt: this.#wrapUpRequestedAt,
			graceDeadlineAt: this.#graceDeadlineAt,
			finalizingAt: this.#finalizingAt,
			terminalAt: this.#terminalAt,
			progress: { ...progress, lastProgressAt: this.#lastProgressAt },
		});
	}

	#reachGraceDeadline(timestamp: number): void {
		if (this.#phase !== "wrap_up_requested" && this.#phase !== "finalizing") return;
		this.#phase = "terminal";
		this.#reason = "grace_deadline_exceeded";
		this.#terminalAt = timestamp;
		this.#cancelTimers();
		this.#hardStopCallback("grace_deadline_exceeded");
	}

	#workDeadlineAt(): number {
		return this.#startedAt + this.#configuration.workDurationMs;
	}

	#cancelTimers(): void {
		this.#workTask?.cancel();
		this.#workTask = undefined;
		this.#graceTask?.cancel();
		this.#graceTask = undefined;
	}
}

function deepFreeze<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	Object.freeze(value);
	for (const item of Object.values(value)) deepFreeze(item);
	return value;
}
