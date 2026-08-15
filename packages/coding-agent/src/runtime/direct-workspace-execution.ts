import type { AgentTool, ToolExecutionContext, ToolExecutionOutput } from "@coda/agent";
import type { WorkspaceExecution } from "@coda/runtime";
import { type WorkspaceLease, WorkspaceLeaseCoordinator } from "./workspace-concurrency.ts";

type WorkspaceToolContribution = Awaited<ReturnType<WorkspaceExecution["tooling"]["tools"]>>[number];
type WorkspacePlacement = Awaited<ReturnType<WorkspaceExecution["placement"]["reserve"]>>["placement"];

export interface DirectWorkspaceToolRequest {
	readonly graphId: string;
	readonly itemId: string;
	readonly sessionId: string;
	readonly placement: WorkspacePlacement;
}

export function createDirectWorkspaceExecution(options: {
	readonly root: string;
	readonly baseIdentity?: () => string | Promise<string>;
	readonly createTools: (
		request: DirectWorkspaceToolRequest,
	) => readonly WorkspaceToolContribution[] | Promise<readonly WorkspaceToolContribution[]>;
	readonly quiesce?: () => Promise<void>;
	readonly quiesceSession?: (sessionId: string) => Promise<void>;
}): WorkspaceExecution {
	const leases = new WorkspaceLeaseCoordinator();
	const retentions = new Set<Promise<void>>();
	const retainedLeases = new Map<string, WorkspaceLease>();
	let closeOperation: Promise<void> | undefined;
	const placement = async (graphId: string, itemId: string): Promise<WorkspacePlacement> => ({
		placementId: `direct:${graphId}:${itemId}`,
		root: options.root,
		baseIdentity: (await options.baseIdentity?.()) ?? `direct:${options.root}`,
		kind: "direct",
	});
	const bind = (contribution: WorkspaceToolContribution): AgentTool => {
		const tool = contribution.tool;
		return Object.freeze({
			...tool,
			execute: async (
				arguments_: Parameters<AgentTool["execute"]>[0],
				context: ToolExecutionContext,
			): Promise<ToolExecutionOutput> => {
				const identity = contribution.leaseIdentity?.(arguments_);
				const inheritedLease = identity ? retainedLeases.get(identity) : undefined;
				const lease = inheritedLease ?? (await leases.acquire(contribution.effect, context.signal));
				let retained = false;
				try {
					const output = await tool.execute(arguments_, context);
					const retention = contribution.retainLease?.(output, context);
					if (retention) {
						if (inheritedLease) throw new Error("A retained Workspace lease cannot be retained again");
						if (retainedLeases.has(retention.identity)) {
							throw new Error(`Workspace lease identity is already retained: ${retention.identity}`);
						}
						retained = true;
						retainedLeases.set(retention.identity, lease);
						const tracked = Promise.resolve(retention.settled).finally(() => {
							if (retainedLeases.get(retention.identity) === lease) retainedLeases.delete(retention.identity);
							lease.release();
						});
						retentions.add(tracked);
						void tracked.finally(() => retentions.delete(tracked)).catch(() => undefined);
					}
					return output;
				} finally {
					if (!inheritedLease && !retained) lease.release();
				}
			},
		} as AgentTool);
	};
	const execution: WorkspaceExecution["placement"] &
		WorkspaceExecution["tooling"] &
		WorkspaceExecution["publication"] = {
		reserve: async (request) => ({
			placement: await placement(String(request.graphId), String(request.itemId)),
			commit: () => Promise.resolve(),
			rollback: () => Promise.resolve(),
		}),
		recover: async (request) => {
			if (request.placement.kind !== "direct" || request.placement.root !== options.root) {
				throw new Error("Recovered Direct Workspace Placement does not match this Workspace");
			}
			return {
				placement: request.placement,
				commit: () => Promise.resolve(),
				rollback: () => Promise.resolve(),
			};
		},
		tools: (request) => options.createTools({ ...request }),
		bindTools: ({ contributions }) => Object.freeze(contributions.map(bind)),
		quiesce: ({ sessionId }) => options.quiesceSession?.(sessionId) ?? Promise.resolve(),
		capture: () => Promise.resolve(undefined),
		publish: () => Promise.resolve({ state: "not_required" }),
		release: () => Promise.resolve(),
		close: () => {
			if (closeOperation) return closeOperation;
			closeOperation = (async () => {
				await options.quiesce?.();
				const settled = await Promise.allSettled([...retentions]);
				await leases.close();
				const failures = settled.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
				if (failures.length === 1) throw failures[0];
				if (failures.length > 1) throw new AggregateError(failures, "Workspace Process lease settlement failed");
			})();
			return closeOperation;
		},
	};
	return Object.freeze({ placement: execution, tooling: execution, publication: execution });
}
