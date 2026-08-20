import type { McpHost, McpHostSnapshot, McpServerDefinition, McpToolLease } from "@coda/mcp";

export interface CodingMcpToolLease extends McpToolLease {
	/** Exact Agent Plugin Server identities bound to this catalog revision. */
	readonly agentPluginServerIds: readonly string[];
}

export interface CodingMcpReloadContext {
	readonly signal?: AbortSignal;
	readonly agentPluginServerIds?: readonly string[];
}

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
	#agentPluginServerIds: readonly string[] = Object.freeze([]);
	#agentPluginServerIdsByRevision = new Map<number, readonly string[]>();
	#reloadTail: Promise<void> = Promise.resolve();
	#reloading = false;
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
		this.#agentPluginServerIdsByRevision.set(this.#host.snapshot().revision, this.#agentPluginServerIds);
		this.#detach = this.#host.onDidChange((snapshot) => this.#observe(snapshot));
	}

	reload(definitions: readonly McpServerDefinition[], context: CodingMcpReloadContext = {}) {
		this.#assertOpen();
		const definitionIds = new Set(definitions.map(({ id }) => id));
		const agentPluginServerIds = Object.freeze([...(context.agentPluginServerIds ?? [])].sort(compareText));
		if (
			new Set(agentPluginServerIds).size !== agentPluginServerIds.length ||
			agentPluginServerIds.some((id) => !definitionIds.has(id))
		) {
			throw new Error("Agent Plugin MCP provenance must contain unique configured Server ids");
		}
		const operation = this.#reloadTail.then(async () => {
			this.#assertOpen();
			this.#reloading = true;
			for (const state of this.#reconnect.values()) state.task?.cancel();
			this.#reconnect.clear();
			try {
				const snapshot = await this.#host.reload(
					definitions,
					context.signal ? { signal: context.signal } : undefined,
				);
				this.#agentPluginServerIds = agentPluginServerIds;
				this.#rememberProvenance(snapshot.revision, agentPluginServerIds);
				return snapshot;
			} finally {
				this.#reloading = false;
			}
		});
		this.#reloadTail = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}

	refresh(context?: { readonly signal?: AbortSignal }) {
		this.#assertOpen();
		return this.#host.refresh(context);
	}

	async reconnect(serverId: string, context?: { readonly signal?: AbortSignal }) {
		this.#assertOpen();
		const state = this.#reconnect.get(serverId);
		state?.task?.cancel();
		this.#reconnect.delete(serverId);
		return this.#host.reconnect(serverId, context);
	}

	snapshot(): McpHostSnapshot {
		return this.#host.snapshot();
	}

	acquireTools(): CodingMcpToolLease {
		this.#assertOpen();
		if (this.#reloading) throw new Error("MCP Tools cannot be acquired during a catalog reload");
		const lease = this.#host.acquireTools();
		const agentPluginServerIds = this.#agentPluginServerIdsByRevision.get(lease.revision);
		if (!agentPluginServerIds) {
			void lease.dispose().catch(() => undefined);
			throw new Error(`MCP provenance is unavailable for catalog revision ${lease.revision}`);
		}
		return Object.freeze({ ...lease, agentPluginServerIds });
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
		if (!this.#reloading) this.#rememberProvenance(snapshot.revision, this.#agentPluginServerIds);
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

	#rememberProvenance(revision: number, agentPluginServerIds: readonly string[]): void {
		this.#agentPluginServerIdsByRevision.clear();
		this.#agentPluginServerIdsByRevision.set(revision, agentPluginServerIds);
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

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
