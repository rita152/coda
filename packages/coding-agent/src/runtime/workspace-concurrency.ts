export type WorkspaceLeaseEffect = "read" | "write" | "unknown";

export interface WorkspaceLease {
	release(): void;
}

interface PendingLease {
	readonly effect: WorkspaceLeaseEffect;
	readonly signal: AbortSignal;
	readonly resolve: (lease: WorkspaceLease) => void;
	readonly reject: (error: Error) => void;
	readonly onAbort: () => void;
}

function abortError(): Error {
	const error = new Error("Workspace lease acquisition was aborted");
	error.name = "AbortError";
	return error;
}

export class WorkspaceLeaseCoordinator {
	readonly #queue: PendingLease[] = [];
	readonly #idleWaiters: Array<() => void> = [];
	#activeReaders = 0;
	#activeWriter = false;
	#closed = false;

	acquire(effect: WorkspaceLeaseEffect, signal: AbortSignal): Promise<WorkspaceLease> {
		if (this.#closed) return Promise.reject(new Error("Workspace lease coordinator is closed"));
		if (signal.aborted) return Promise.reject(abortError());
		return new Promise((resolve, reject) => {
			const pending: PendingLease = {
				effect,
				signal,
				resolve,
				reject,
				onAbort: () => {
					const index = this.#queue.indexOf(pending);
					if (index < 0) return;
					this.#queue.splice(index, 1);
					reject(abortError());
					this.#drain();
				},
			};
			signal.addEventListener("abort", pending.onAbort, { once: true });
			this.#queue.push(pending);
			this.#drain();
		});
	}

	async close(): Promise<void> {
		if (!this.#closed) {
			this.#closed = true;
			for (const pending of this.#queue.splice(0)) {
				pending.signal.removeEventListener("abort", pending.onAbort);
				pending.reject(new Error("Workspace lease coordinator closed before acquisition"));
			}
		}
		if (this.#activeReaders === 0 && !this.#activeWriter) return;
		await new Promise<void>((resolve) => this.#idleWaiters.push(resolve));
	}

	#drain(): void {
		if (this.#activeWriter || this.#queue.length === 0) return;
		const first = this.#queue[0];
		if (!first) return;
		if (first.effect !== "read") {
			if (this.#activeReaders > 0) return;
			this.#queue.shift();
			this.#grant(first, false);
			return;
		}
		while (this.#queue[0]?.effect === "read" && !this.#activeWriter) {
			const pending = this.#queue.shift();
			if (pending) this.#grant(pending, true);
		}
	}

	#grant(pending: PendingLease, read: boolean): void {
		pending.signal.removeEventListener("abort", pending.onAbort);
		if (read) this.#activeReaders++;
		else this.#activeWriter = true;
		let released = false;
		pending.resolve({
			release: () => {
				if (released) return;
				released = true;
				if (read) this.#activeReaders--;
				else this.#activeWriter = false;
				this.#notifyIdle();
				this.#drain();
			},
		});
	}

	#notifyIdle(): void {
		if (this.#activeReaders > 0 || this.#activeWriter) return;
		for (const resolve of this.#idleWaiters.splice(0)) resolve();
	}
}
