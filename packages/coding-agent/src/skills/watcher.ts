import { type FSWatcher, statSync, watch } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

export interface SkillWatcher {
	reconcile(locations: readonly string[]): void;
	dispose(): void;
}

export interface SkillWatcherFactory {
	watch(locations: readonly string[], onChange: () => void, onError?: (error: Error) => void): SkillWatcher;
}

interface DesiredWatch {
	readonly directChildren: ReadonlySet<string>;
	readonly recursive: boolean;
}

interface ActiveWatchState {
	directChildren: ReadonlySet<string>;
	failed: boolean;
	readonly recursive: boolean;
}

interface ActiveWatch {
	readonly state: ActiveWatchState;
	readonly watcher: FSWatcher;
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function isMissingPathError(error: unknown): boolean {
	return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function sameChildren(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
	if (left.size !== right.size) return false;
	for (const child of left) if (!right.has(child)) return false;
	return true;
}

function sameWatchPlans(left: ReadonlyMap<string, DesiredWatch>, right: ReadonlyMap<string, DesiredWatch>): boolean {
	if (left.size !== right.size) return false;
	for (const [path, expected] of left) {
		const actual = right.get(path);
		if (!actual || actual.recursive !== expected.recursive) return false;
		if (!sameChildren(actual.directChildren, expected.directChildren)) return false;
	}
	return true;
}

/** Node adapter that follows missing roots without recursively watching their broad ancestors. */
export function createNodeSkillWatcherFactory(): SkillWatcherFactory {
	return Object.freeze({
		watch: (locations: readonly string[], onChange: () => void, onError?: (error: Error) => void) => {
			let targets = [...new Set(locations.map((location) => resolve(location)))].sort();
			const watchers = new Map<string, ActiveWatch>();
			const locationErrors = new Map<string, string>();
			let disposed = false;
			let reconciling = false;
			let reconcileAgain = false;
			let reconcileScheduled = false;

			const reportLocationError = (location: string, error: Error | undefined): void => {
				if (!error) {
					locationErrors.delete(location);
					return;
				}
				const identity = `${error.name}\0${error.message}`;
				if (locationErrors.get(location) === identity) return;
				locationErrors.set(location, identity);
				onError?.(error);
			};

			const collectDesiredWatches = (): Map<string, DesiredWatch> => {
				const desired = new Map<string, { directChildren: Set<string>; recursive: boolean }>();
				for (const location of targets) {
					let candidate = location;
					let locationError: Error | undefined;
					while (true) {
						try {
							const status = statSync(candidate);
							if (!status.isDirectory()) {
								locationError ??= new Error(`Watch location crosses a non-directory path: ${candidate}`);
								const parent = dirname(candidate);
								if (parent === candidate) break;
								candidate = parent;
								continue;
							}

							const recursive = candidate === location;
							const directChild = recursive ? undefined : relative(candidate, location).split(sep)[0];
							const current = desired.get(candidate);
							if (current) {
								current.recursive ||= recursive;
								if (directChild) current.directChildren.add(directChild);
							} else {
								desired.set(candidate, {
									directChildren: new Set(directChild ? [directChild] : []),
									recursive,
								});
							}
							break;
						} catch (error) {
							if (!isMissingPathError(error)) {
								locationError = toError(error);
								break;
							}
							const parent = dirname(candidate);
							if (parent === candidate) {
								locationError = toError(error);
								break;
							}
							candidate = parent;
						}
					}
					reportLocationError(location, locationError);
				}
				return desired;
			};

			const closeWatcher = (active: ActiveWatch): void => {
				active.watcher.removeAllListeners();
				active.watcher.close();
			};

			const scheduleReconcile = (): void => {
				if (disposed || reconcileScheduled) return;
				reconcileScheduled = true;
				queueMicrotask(() => {
					reconcileScheduled = false;
					reconcile();
				});
			};

			const openWatcher = (path: string, desired: DesiredWatch): ActiveWatch | undefined => {
				const state: ActiveWatchState = {
					directChildren: desired.directChildren,
					failed: false,
					recursive: desired.recursive,
				};
				try {
					const watcher = watch(path, { recursive: state.recursive }, (_eventType, filename) => {
						if (disposed) return;
						if (!state.recursive && filename !== null) {
							const directChild = filename.toString().split(sep)[0];
							if (!directChild || !state.directChildren.has(directChild)) return;
						}
						reconcile();
						if (!disposed) onChange();
					});
					watcher.on("error", (error) => {
						if (disposed) return;
						state.failed = true;
						onError?.(error);
						scheduleReconcile();
					});
					return { state, watcher };
				} catch (error) {
					if (isMissingPathError(error)) reconcileAgain = true;
					else onError?.(toError(error));
					return undefined;
				}
			};

			const reconcile = (): void => {
				if (disposed) return;
				if (reconciling) {
					reconcileAgain = true;
					return;
				}
				reconciling = true;
				let passes = 0;
				try {
					do {
						reconcileAgain = false;
						const desired = collectDesiredWatches();
						for (const [path, plan] of desired) {
							const active = watchers.get(path);
							if (active && !active.state.failed && active.state.recursive === plan.recursive) {
								active.state.directChildren = plan.directChildren;
								continue;
							}
							const replacement = openWatcher(path, plan);
							if (!replacement) continue;
							if (active) closeWatcher(active);
							watchers.set(path, replacement);
						}
						for (const [path, active] of watchers) {
							if (desired.has(path)) continue;
							closeWatcher(active);
							watchers.delete(path);
						}
						const verified = collectDesiredWatches();
						if (!sameWatchPlans(desired, verified)) reconcileAgain = true;
						passes += 1;
					} while (!disposed && reconcileAgain && passes < 4);
				} finally {
					reconciling = false;
					if (reconcileAgain) scheduleReconcile();
				}
			};

			reconcile();
			return Object.freeze({
				reconcile: (locations: readonly string[]) => {
					if (disposed) return;
					targets = [...new Set(locations.map((location) => resolve(location)))].sort();
					reconcile();
				},
				dispose: () => {
					if (disposed) return;
					disposed = true;
					for (const active of watchers.values()) closeWatcher(active);
					watchers.clear();
				},
			});
		},
	});
}
