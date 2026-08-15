import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { AgentTool, ToolExecutionContext, ToolExecutionOutput } from "@coda/agent";
import type {
	PublicationOutcome,
	WorkspaceArtifact,
	WorkspaceExecution,
	WorkspacePlacementDescriptor,
} from "@coda/runtime";
import type { ProcessRunner, ProcessRunResult } from "../host/process-runner.ts";

type WorkspaceToolContribution = Awaited<ReturnType<WorkspaceExecution["tooling"]["tools"]>>[number];

interface PublicationTicket {
	wait(signal: AbortSignal): Promise<void>;
	settle(): void;
}

class PublicationSequencer {
	readonly #tickets = new Map<
		number,
		{
			readonly ready: Promise<void>;
			readonly resolve: () => void;
			requested: boolean;
			resolved: boolean;
			settled: boolean;
		}
	>();
	#active?: number;

	register(order: number): PublicationTicket {
		if (!Number.isSafeInteger(order) || order < 0)
			throw new Error("Publication order must be a non-negative integer");
		if (this.#tickets.has(order)) throw new Error(`Publication order is already registered: ${order}`);
		let resolve!: () => void;
		const ready = new Promise<void>((settle) => {
			resolve = settle;
		});
		const state = { ready, resolve, requested: false, resolved: false, settled: false };
		this.#tickets.set(order, state);
		return Object.freeze({
			wait: (signal: AbortSignal) => {
				state.requested = true;
				this.#advance();
				return abortable(state.ready, signal);
			},
			settle: () => {
				if (state.settled) return;
				state.settled = true;
				if (this.#active === order) this.#active = undefined;
				this.#advance();
			},
		});
	}

	#advance(): void {
		if (this.#active !== undefined) {
			const active = this.#tickets.get(this.#active);
			if (active?.requested && !active.resolved) {
				active.resolved = true;
				active.resolve();
			}
			return;
		}
		for (;;) {
			const next = [...this.#tickets.entries()].sort(([left], [right]) => left - right)[0];
			if (!next) return;
			const [order, state] = next;
			if (state.settled) {
				this.#tickets.delete(order);
				continue;
			}
			this.#active = order;
			if (state.requested && !state.resolved) {
				state.resolved = true;
				state.resolve();
			}
			return;
		}
	}
}

class TargetMutationGate {
	#tail: Promise<void> = Promise.resolve();

	run<Result>(operation: () => Promise<Result>): Promise<Result> {
		const result = this.#tail.then(operation);
		this.#tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
}

function abortable(operation: Promise<void>, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise<void>((resolve, reject) => {
		const onAbort = () => {
			signal.removeEventListener("abort", onAbort);
			reject(signal.reason);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		operation.then(
			() => {
				signal.removeEventListener("abort", onAbort);
				resolve();
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

interface PlacementState {
	readonly placementId: string;
	readonly graphId: string;
	readonly itemId: string;
	readonly descriptor: WorkspacePlacementDescriptor;
	readonly repoRoot: string;
	readonly workspacePrefix: string;
	readonly worktreeRoot: string;
	readonly baseCommit: string;
	readonly publicationOrder: number;
	readonly derived: boolean;
	readonly target: PublicationTarget;
	readonly publications: PublicationSequencer;
	readonly mutations: TargetMutationGate;
	knownFingerprint: string;
	ticket?: PublicationTicket;
	artifactRef?: string;
	preserve: boolean;
}

interface PublicationTarget {
	readonly placementId: string;
	readonly repoRoot: string;
	readonly publications: PublicationSequencer;
	readonly mutations: TargetMutationGate;
	knownFingerprint: string;
}

export interface GitWorktreeToolRequest {
	readonly graphId: string;
	readonly itemId: string;
	readonly sessionId: string;
	readonly placement: WorkspacePlacementDescriptor;
}

function contained(root: string, path: string): boolean {
	const fromRoot = relative(root, path);
	return fromRoot === "" || (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`));
}

function stableName(graphId: string, itemId: string): string {
	return createHash("sha256").update(`${graphId}\0${itemId}`).digest("hex").slice(0, 24);
}

export async function createGitWorktreeWorkspaceExecution(options: {
	readonly sourceRoot: string;
	readonly stateRoot: string;
	readonly processRunner: ProcessRunner;
	readonly environment: Readonly<Record<string, string>>;
	readonly gitExecutable?: string;
	readonly createTools: (
		request: GitWorktreeToolRequest,
	) => readonly WorkspaceToolContribution[] | Promise<readonly WorkspaceToolContribution[]>;
	readonly quiesceSession?: (sessionId: string) => Promise<void>;
}): Promise<WorkspaceExecution> {
	const gitExecutable = options.gitExecutable ?? "git";
	const sourceRoot = await realpath(resolve(options.sourceRoot));
	const stateRoot = resolve(options.stateRoot);
	await mkdir(stateRoot, { recursive: true });
	const runGit = async (
		cwd: string,
		args: readonly string[],
		signal: AbortSignal = new AbortController().signal,
		environment: Readonly<Record<string, string>> = options.environment,
	): Promise<ProcessRunResult> =>
		options.processRunner.run({
			executable: gitExecutable,
			args,
			cwd,
			environment,
			signal,
			timeoutMs: 120_000,
			maxOutputBytes: 2 * 1024 * 1024,
			maxOutputLines: 20_000,
		});
	const checkedGit = async (
		cwd: string,
		args: readonly string[],
		signal?: AbortSignal,
		environment?: Readonly<Record<string, string>>,
	): Promise<string> => {
		const result = await runGit(cwd, args, signal, environment);
		if (result.exitCode !== 0 || result.timedOut) {
			throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
		}
		return result.stdout.trim();
	};
	const sourceRepoRoot = resolve(await checkedGit(sourceRoot, ["rev-parse", "--show-toplevel"]));
	if (!contained(sourceRepoRoot, sourceRoot)) {
		throw new Error(`Workspace root ${sourceRoot} is outside its Git repository ${sourceRepoRoot}`);
	}
	const workspacePrefix = relative(sourceRepoRoot, sourceRoot);
	const workspaceTree = async (repoRoot: string, signal?: AbortSignal): Promise<string> => {
		const temporary = await mkdtemp(join(stateRoot, "index-"));
		const index = join(temporary, "index");
		const environment = { ...options.environment, GIT_INDEX_FILE: index };
		try {
			await checkedGit(repoRoot, ["read-tree", "HEAD"], signal, environment);
			await checkedGit(repoRoot, ["add", "-A", "--", "."], signal, environment);
			return await checkedGit(repoRoot, ["write-tree"], signal, environment);
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	};
	const fingerprint = async (repoRoot: string, signal?: AbortSignal): Promise<string> => {
		const [head, status, tree] = await Promise.all([
			checkedGit(repoRoot, ["rev-parse", "HEAD"], signal),
			checkedGit(repoRoot, ["status", "--porcelain=v2", "-z", "--untracked-files=all"], signal),
			workspaceTree(repoRoot, signal),
		]);
		return createHash("sha256").update(head).update("\0").update(status).update("\0").update(tree).digest("hex");
	};
	const sourceTarget: PublicationTarget = {
		placementId: `git-source:${createHash("sha256").update(sourceRepoRoot).digest("hex").slice(0, 16)}`,
		repoRoot: sourceRepoRoot,
		publications: new PublicationSequencer(),
		mutations: new TargetMutationGate(),
		knownFingerprint: await fingerprint(sourceRepoRoot),
	};
	const states = new Map<string, PlacementState>();
	const itemStates = new Map<string, PlacementState>();
	let closeOperation: Promise<void> | undefined;
	const itemKey = (graphId: string, itemId: string): string => `${graphId}\0${itemId}`;
	const freeze = async (repoRoot: string, label: string, signal?: AbortSignal): Promise<string> => {
		const environment = {
			...options.environment,
			GIT_AUTHOR_NAME: "Coda Work Graph",
			GIT_AUTHOR_EMAIL: "coda-work-graph@localhost",
			GIT_AUTHOR_DATE: "1970-01-01T00:00:00Z",
			GIT_COMMITTER_NAME: "Coda Work Graph",
			GIT_COMMITTER_EMAIL: "coda-work-graph@localhost",
			GIT_COMMITTER_DATE: "1970-01-01T00:00:00Z",
		};
		const [tree, parent] = await Promise.all([
			workspaceTree(repoRoot, signal),
			checkedGit(repoRoot, ["rev-parse", "HEAD"], signal),
		]);
		return checkedGit(repoRoot, ["commit-tree", tree, "-p", parent, "-m", label], signal, environment);
	};
	const publicationTarget = (parent?: WorkspacePlacementDescriptor): PublicationTarget => {
		if (!parent) return sourceTarget;
		const state = states.get(parent.placementId);
		if (!state) throw new Error(`Parent Workspace Placement is not owned by this Adapter: ${parent.placementId}`);
		return state;
	};
	const assertTargetUnchanged = async (
		target: PublicationTarget,
		operation: string,
		signal?: AbortSignal,
	): Promise<string> => {
		const current = await fingerprint(target.repoRoot, signal);
		if (current !== target.knownFingerprint) {
			throw new Error(`Target Workspace changed outside the Adapter before ${operation}: ${target.placementId}`);
		}
		return current;
	};
	const createPlacement = async (request: Parameters<WorkspaceExecution["placement"]["reserve"]>[0]) => {
		const graphId = String(request.graphId);
		const workItemId = String(request.itemId);
		const target = publicationTarget(request.parent);
		if (request.mode === "read_only") {
			const root = request.parent?.root ?? sourceRoot;
			const repoRoot = resolve(await checkedGit(root, ["rev-parse", "--show-toplevel"]));
			const descriptor: WorkspacePlacementDescriptor = {
				placementId: `git-read:${graphId}:${workItemId}`,
				root,
				baseIdentity: await checkedGit(repoRoot, ["rev-parse", "HEAD"]),
				targetPlacementId: target.placementId,
				targetIdentity: target.knownFingerprint,
				kind: "git_worktree",
			};
			const state: PlacementState = {
				placementId: descriptor.placementId,
				graphId,
				itemId: workItemId,
				descriptor,
				repoRoot,
				workspacePrefix: relative(repoRoot, root),
				worktreeRoot: repoRoot,
				baseCommit: descriptor.baseIdentity,
				publicationOrder: request.publicationOrder,
				derived: false,
				target,
				publications: new PublicationSequencer(),
				mutations: new TargetMutationGate(),
				knownFingerprint: await fingerprint(repoRoot),
				preserve: false,
			};
			states.set(descriptor.placementId, state);
			itemStates.set(itemKey(graphId, workItemId), state);
			return state;
		}
		const targetRepoRoot = target.repoRoot;
		const frozenTarget = await target.mutations.run(async () => {
			const before = await assertTargetUnchanged(target, "Placement reservation");
			const commit = await freeze(targetRepoRoot, `Coda placement base ${graphId}/${workItemId}`);
			const after = await fingerprint(targetRepoRoot);
			if (after !== before) {
				throw new Error(`Target Workspace changed while reserving Placement: ${target.placementId}`);
			}
			return { baseCommit: commit, targetIdentity: before };
		});
		const { baseCommit, targetIdentity } = frozenTarget;
		const worktreeRoot = join(stateRoot, "worktrees", stableName(graphId, workItemId));
		await mkdir(join(stateRoot, "worktrees"), { recursive: true });
		await checkedGit(targetRepoRoot, ["worktree", "add", "--detach", worktreeRoot, baseCommit]);
		const root = workspacePrefix.length === 0 ? worktreeRoot : join(worktreeRoot, workspacePrefix);
		const descriptor: WorkspacePlacementDescriptor = {
			placementId: `git-worktree:${graphId}:${workItemId}`,
			root,
			baseIdentity: baseCommit,
			targetPlacementId: target.placementId,
			targetIdentity,
			kind: "git_worktree",
		};
		const state: PlacementState = {
			placementId: descriptor.placementId,
			graphId,
			itemId: workItemId,
			descriptor,
			repoRoot: worktreeRoot,
			workspacePrefix,
			worktreeRoot,
			baseCommit,
			publicationOrder: request.publicationOrder,
			derived: true,
			target,
			publications: new PublicationSequencer(),
			mutations: new TargetMutationGate(),
			knownFingerprint: await fingerprint(worktreeRoot),
			preserve: false,
		};
		states.set(descriptor.placementId, state);
		itemStates.set(itemKey(graphId, workItemId), state);
		return state;
	};
	const bind = (state: PlacementState, contribution: WorkspaceToolContribution): AgentTool => {
		const tool = contribution.tool;
		return Object.freeze({
			...tool,
			execute: async (
				arguments_: Parameters<AgentTool["execute"]>[0],
				context: ToolExecutionContext,
			): Promise<ToolExecutionOutput> => {
				if (contribution.effect === "read") return tool.execute(arguments_, context);
				return state.mutations.run(async () => {
					await assertTargetUnchanged(state, `Tool mutation ${tool.name}`, context.signal);
					const output = await tool.execute(arguments_, context);
					state.knownFingerprint = await fingerprint(state.repoRoot, context.signal);
					return output;
				});
			},
		} as AgentTool);
	};
	const execution: WorkspaceExecution["placement"] &
		WorkspaceExecution["tooling"] &
		WorkspaceExecution["publication"] = {
		reserve: async (request) => {
			const state = await createPlacement(request);
			return {
				placement: state.descriptor,
				commit: async () => {
					state.ticket ??= state.target.publications.register(state.publicationOrder);
				},
				rollback: async () => {
					state.ticket?.settle();
					states.delete(state.descriptor.placementId);
					itemStates.delete(itemKey(state.graphId, state.itemId));
					if (state.derived) {
						await runGit(sourceRepoRoot, ["worktree", "remove", "--force", state.worktreeRoot]).catch(
							() => undefined,
						);
					}
				},
			};
		},
		recover: async (request) => {
			const descriptor = request.placement;
			if (descriptor.kind !== "git_worktree") throw new Error("Recovered Placement is not a Git worktree");
			const repoRoot = resolve(await checkedGit(descriptor.root, ["rev-parse", "--show-toplevel"]));
			const parent = request.parentItemId
				? itemStates.get(itemKey(String(request.graphId), String(request.parentItemId)))
				: undefined;
			if (request.parentItemId && !parent) {
				throw new Error(`Recovered parent Placement is unavailable: ${request.parentItemId}`);
			}
			const target = parent ?? sourceTarget;
			if (!descriptor.targetPlacementId || !descriptor.targetIdentity) {
				throw new Error(`Recovered Git Placement has no durable target identity: ${descriptor.placementId}`);
			}
			if (descriptor.targetPlacementId !== target.placementId) {
				throw new Error(
					`Recovered Publication target changed from ${descriptor.targetPlacementId} to ${target.placementId}`,
				);
			}
			const expectedTargetIdentity = request.expectedTargetIdentity ?? descriptor.targetIdentity;
			await target.mutations.run(async () => {
				const current = await fingerprint(target.repoRoot);
				if (current !== expectedTargetIdentity) {
					throw new Error(`Recovered Publication target changed outside the Adapter: ${target.placementId}`);
				}
				target.knownFingerprint = current;
			});
			const state: PlacementState = {
				placementId: descriptor.placementId,
				graphId: String(request.graphId),
				itemId: String(request.itemId),
				descriptor,
				repoRoot,
				workspacePrefix: relative(repoRoot, descriptor.root),
				worktreeRoot: repoRoot,
				baseCommit: descriptor.baseIdentity,
				publicationOrder: request.publicationOrder,
				derived: request.mode === "write",
				target,
				publications: new PublicationSequencer(),
				mutations: new TargetMutationGate(),
				knownFingerprint: await fingerprint(repoRoot),
				preserve: false,
			};
			return {
				placement: descriptor,
				commit: async () => {
					states.set(descriptor.placementId, state);
					itemStates.set(itemKey(state.graphId, state.itemId), state);
					state.ticket ??= state.target.publications.register(state.publicationOrder);
				},
				rollback: async () => state.ticket?.settle(),
			};
		},
		tools: async (request) => {
			const state = states.get(request.placement.placementId);
			if (!state) throw new Error(`Workspace Placement is not active: ${request.placement.placementId}`);
			return options.createTools({ ...request });
		},
		bindTools: (request) => {
			const state = states.get(request.placement.placementId);
			if (!state) throw new Error(`Workspace Placement is not active: ${request.placement.placementId}`);
			return Object.freeze(request.contributions.map((contribution) => bind(state, contribution)));
		},
		quiesce: ({ sessionId }) => options.quiesceSession?.(sessionId) ?? Promise.resolve(),
		capture: async (request): Promise<WorkspaceArtifact | undefined> => {
			const state = states.get(request.placement.placementId);
			if (!state) throw new Error(`Workspace Placement is not active: ${request.placement.placementId}`);
			if (!state.derived) return undefined;
			const commit = await state.mutations.run(() =>
				freeze(state.repoRoot, `Coda Work Artifact ${state.graphId}/${state.itemId}`, request.signal),
			);
			const artifactRef = `refs/coda/work-artifacts/${stableName(state.graphId, state.itemId)}`;
			await checkedGit(state.repoRoot, ["update-ref", artifactRef, commit], request.signal);
			state.artifactRef = artifactRef;
			return {
				artifactId: `git-artifact:${state.graphId}:${state.itemId}`,
				placementId: state.descriptor.placementId,
				baseIdentity: state.baseCommit,
				kind: "git_commit",
				reference: commit,
				metadata: {
					ref: artifactRef,
					worktreeRoot: state.worktreeRoot,
					targetPlacementId: state.target.placementId,
				},
			};
		},
		publish: async (request): Promise<PublicationOutcome> => {
			const state = states.get(request.placement.placementId);
			const artifactReference = request.artifact.reference;
			if (!state || !state.derived || !artifactReference) return { state: "not_required" };
			if (!state.ticket) throw new Error(`Workspace Placement was not committed: ${state.descriptor.placementId}`);
			await state.ticket.wait(request.signal);
			try {
				return await state.target.mutations.run(async () => {
					const targetPlacementId = state.target.placementId;
					const targetRepoRoot = state.target.repoRoot;
					const currentFingerprint = await fingerprint(targetRepoRoot, request.signal);
					if (currentFingerprint !== state.target.knownFingerprint) {
						state.preserve = true;
						return {
							state: "not_published",
							targetPlacementId,
							reason: "changed_source",
							diagnostic: "Target Workspace changed outside the Adapter after Placement",
						} as const;
					}
					const temporary = await mkdtemp(join(stateRoot, "publication-"));
					const patch = join(temporary, "artifact.patch");
					try {
						await checkedGit(
							state.repoRoot,
							["diff", "--binary", "--full-index", `--output=${patch}`, state.baseCommit, artifactReference],
							request.signal,
						);
						if ((await readFile(patch)).byteLength === 0) {
							return {
								state: "not_required",
								targetPlacementId,
								targetIdentity: state.target.knownFingerprint,
							} as const;
						}
						const check = await runGit(targetRepoRoot, ["apply", "--check", "--binary", patch], request.signal);
						if (check.exitCode !== 0 || check.timedOut) {
							state.preserve = true;
							return {
								state: "not_published",
								targetPlacementId,
								reason: "conflict",
								diagnostic: (check.stderr || check.stdout).trim(),
							} as const;
						}
						await checkedGit(targetRepoRoot, ["apply", "--binary", patch], request.signal);
						const targetIdentity = await fingerprint(targetRepoRoot, request.signal);
						state.target.knownFingerprint = targetIdentity;
						return {
							state: "published",
							publicationId: `git-publication:${state.graphId}:${state.itemId}`,
							targetPlacementId,
							targetIdentity,
						} as const;
					} finally {
						await rm(temporary, { recursive: true, force: true });
					}
				});
			} finally {
				state.ticket.settle();
			}
		},
		release: async (request) => {
			const state = states.get(request.placement.placementId);
			if (!state) return;
			state.ticket?.settle();
			state.preserve ||= request.preserve;
			if (state.preserve) return;
			states.delete(state.descriptor.placementId);
			itemStates.delete(itemKey(state.graphId, state.itemId));
			if (!state.derived) return;
			await checkedGit(sourceRepoRoot, ["worktree", "remove", "--force", state.worktreeRoot]);
			if (state.artifactRef) await checkedGit(sourceRepoRoot, ["update-ref", "-d", state.artifactRef]);
		},
		close: () => {
			if (closeOperation) return closeOperation;
			closeOperation = Promise.resolve();
			return closeOperation;
		},
	};
	return Object.freeze({ placement: execution, tooling: execution, publication: execution });
}
