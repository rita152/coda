import type { McpHost, McpHostSnapshot, McpServerDefinition, McpToolSnapshot } from "@coda/mcp";

export interface McpRegistryScheduler {
	schedule(delayMs: number, task: () => void): { cancel(): void };
}

interface ReconnectState {
	nextDelay: number;
	reconnecting: boolean;
	task?: { cancel(): void };
}

const DEFAULT_RECONNECT_DELAYS_MS = Object.freeze([1_000, 2_000, 5_000, 10_000, 30_000]);

export class CodingMcpRegistry {
	readonly #host: McpHost;
	readonly #scheduler?: McpRegistryScheduler;
	readonly #reconnectDelaysMs: readonly number[];
	readonly #reconnect = new Map<string, ReconnectState>();
	readonly #detach: () => void;
	#closed = false;

	constructor(options: {
		readonly host: McpHost;
		readonly scheduler?: McpRegistryScheduler;
		readonly reconnectDelaysMs?: readonly number[];
	}) {
		this.#host = options.host;
		this.#scheduler = options.scheduler;
		this.#reconnectDelaysMs = Object.freeze([...(options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS)]);
		if (this.#reconnectDelaysMs.some((delay) => !Number.isFinite(delay) || delay < 0)) {
			throw new Error("MCP reconnect delays must be non-negative finite numbers");
		}
		this.#detach = this.#host.onDidChange((snapshot) => this.#observe(snapshot));
	}

	reload(
		definitions: readonly McpServerDefinition[],
		context?: { readonly signal?: AbortSignal },
	): Promise<McpHostSnapshot> {
		this.#assertOpen();
		for (const state of this.#reconnect.values()) state.task?.cancel();
		this.#reconnect.clear();
		return this.#host.reload(definitions, context);
	}

	refresh(context?: { readonly signal?: AbortSignal }): Promise<McpHostSnapshot> {
		this.#assertOpen();
		return this.#host.refresh(context);
	}

	async reconnect(serverId: string, context?: { readonly signal?: AbortSignal }): Promise<McpHostSnapshot> {
		this.#assertOpen();
		const state = this.#reconnect.get(serverId);
		state?.task?.cancel();
		this.#reconnect.delete(serverId);
		return this.#host.reconnect(serverId, context);
	}

	snapshot(): McpHostSnapshot {
		return this.#host.snapshot();
	}

	freezeTools(): McpToolSnapshot {
		this.#assertOpen();
		return this.#host.freezeTools();
	}

	onDidChange(listener: (snapshot: McpHostSnapshot) => void): () => void {
		this.#assertOpen();
		return this.#host.onDidChange(listener);
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#detach();
		for (const state of this.#reconnect.values()) state.task?.cancel();
		this.#reconnect.clear();
		await this.#host.close();
	}

	#observe(snapshot: McpHostSnapshot): void {
		if (this.#closed) return;
		const visible = new Set(snapshot.servers.map(({ id }) => id));
		for (const [serverId, state] of this.#reconnect) {
			if (visible.has(serverId)) continue;
			state.task?.cancel();
			this.#reconnect.delete(serverId);
		}
		for (const server of snapshot.servers) {
			if (server.status !== "degraded") {
				const state = this.#reconnect.get(server.id);
				state?.task?.cancel();
				this.#reconnect.delete(server.id);
				continue;
			}
			this.#schedule(server.id);
		}
	}

	#schedule(serverId: string): void {
		if (!this.#scheduler || this.#reconnectDelaysMs.length === 0 || this.#closed) return;
		const state = this.#reconnect.get(serverId) ?? { nextDelay: 0, reconnecting: false };
		this.#reconnect.set(serverId, state);
		if (state.task || state.reconnecting || state.nextDelay >= this.#reconnectDelaysMs.length) return;
		const delay = this.#reconnectDelaysMs[state.nextDelay++]!;
		state.task = this.#scheduler.schedule(delay, () => {
			state.task = undefined;
			state.reconnecting = true;
			void this.#host
				.reconnect(serverId)
				.then((snapshot) => {
					if (snapshot.servers.find((server) => server.id === serverId)?.status === "ready") {
						this.#reconnect.delete(serverId);
					}
				})
				.catch(() => undefined)
				.finally(() => {
					state.reconnecting = false;
					if (this.#reconnect.get(serverId) === state) this.#schedule(serverId);
				});
		});
	}

	#assertOpen(): void {
		if (this.#closed) throw new Error("MCP Registry is closed");
	}
}
