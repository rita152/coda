import { type FSWatcher, watch } from "node:fs";

export interface SkillWatcher {
	dispose(): void;
}

export interface SkillWatcherFactory {
	watch(locations: readonly string[], onChange: () => void, onError?: (error: Error) => void): SkillWatcher;
}

/** Node adapter. Correctness does not rely on delivery: every Run still performs a bounded rescan. */
export function createNodeSkillWatcherFactory(): SkillWatcherFactory {
	return Object.freeze({
		watch: (locations: readonly string[], onChange: () => void, onError?: (error: Error) => void) => {
			const watchers: FSWatcher[] = [];
			for (const location of [...new Set(locations)].sort()) {
				try {
					const watcher = watch(location, { recursive: true }, () => onChange());
					watcher.on("error", (error) => onError?.(error));
					watchers.push(watcher);
				} catch (error) {
					if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
					onError?.(error instanceof Error ? error : new Error(String(error)));
				}
			}
			return Object.freeze({
				dispose: () => {
					for (const watcher of watchers) watcher.close();
				},
			});
		},
	});
}
