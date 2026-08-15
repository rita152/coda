import type { ScheduledTask, Scheduler } from "@coda/tui";
import type { ProcessRunner } from "../host/process-runner.ts";
import type { GitStatusSnapshot } from "./status-line.ts";

export interface WorkspaceGitStatusOptions {
	readonly processRunner: ProcessRunner;
	readonly workspace: string;
	readonly environment: Readonly<Record<string, string | undefined>>;
	readonly onChange: () => void;
	readonly scheduler?: Scheduler;
	readonly refreshIntervalMs?: number;
}

export class WorkspaceGitStatus {
	readonly #options: WorkspaceGitStatusOptions;
	readonly #controller = new AbortController();
	#snapshot?: GitStatusSnapshot;
	#refreshing?: Promise<void>;
	#refreshAgain = false;
	#disposed = false;
	#poll?: ScheduledTask;
	#started = false;

	constructor(options: WorkspaceGitStatusOptions) {
		this.#options = options;
	}

	get snapshot(): GitStatusSnapshot | undefined {
		return this.#snapshot ? { ...this.#snapshot } : undefined;
	}

	start(): void {
		if (this.#started || this.#disposed) return;
		this.#started = true;
		void this.refresh().finally(() => this.#schedulePoll());
	}

	refresh(): Promise<void> {
		if (this.#disposed) return Promise.resolve();
		if (this.#refreshing) {
			this.#refreshAgain = true;
			return this.#refreshing;
		}
		const operation = this.#runRefresh().finally(() => {
			if (this.#refreshing !== operation) return;
			this.#refreshing = undefined;
			if (this.#refreshAgain && !this.#disposed) {
				this.#refreshAgain = false;
				void this.refresh();
			}
		});
		this.#refreshing = operation;
		return operation;
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#poll?.cancel();
		this.#poll = undefined;
		this.#controller.abort();
	}

	async #runRefresh(): Promise<void> {
		let next: GitStatusSnapshot | undefined;
		try {
			const result = await this.#options.processRunner.run({
				executable: "git",
				args: ["status", "--porcelain=v2", "--branch", "--untracked-files=normal"],
				cwd: this.#options.workspace,
				environment: definedEnvironment(this.#options.environment),
				signal: this.#controller.signal,
				timeoutMs: 2_000,
				maxOutputBytes: 64 * 1_024,
				maxOutputLines: 1_024,
			});
			if (result.exitCode === 0 && !result.timedOut) next = parseGitStatus(result.stdout);
		} catch {
			next = undefined;
		}
		if (sameStatus(this.#snapshot, next)) return;
		this.#snapshot = next;
		this.#options.onChange();
	}

	#schedulePoll(): void {
		if (this.#disposed || !this.#options.scheduler || this.#poll) return;
		this.#poll = this.#options.scheduler.schedule(this.#options.refreshIntervalMs ?? 3_000, async () => {
			this.#poll = undefined;
			await this.refresh();
			this.#schedulePoll();
		});
	}
}

export function parseGitStatus(output: string): GitStatusSnapshot | undefined {
	let branch: string | undefined;
	let detachedHead: string | undefined;
	let oid: string | undefined;
	let dirty = false;
	for (const line of output.split(/\r?\n/u)) {
		if (!line) continue;
		if (line.startsWith("# branch.head ")) {
			const value = line.slice("# branch.head ".length).trim();
			if (value && value !== "(detached)" && value !== "(unknown)") branch = value;
			continue;
		}
		if (line.startsWith("# branch.oid ")) {
			oid = line.slice("# branch.oid ".length).trim();
			continue;
		}
		if (!line.startsWith("# ")) dirty = true;
	}
	if (!branch && oid && oid !== "(initial)") detachedHead = oid.slice(0, 7);
	if (!branch && !detachedHead) return undefined;
	return { ...(branch ? { branch } : {}), ...(detachedHead ? { detachedHead } : {}), dirty };
}

function definedEnvironment(
	environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
	return Object.fromEntries(
		Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined),
	);
}

function sameStatus(left: GitStatusSnapshot | undefined, right: GitStatusSnapshot | undefined): boolean {
	return left?.branch === right?.branch && left?.detachedHead === right?.detachedHead && left?.dirty === right?.dirty;
}
