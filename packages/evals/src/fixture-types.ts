import type { FixtureCategory } from "./types.ts";

export type FixtureCheck =
	| { readonly id: string; readonly kind: "contains"; readonly path: string; readonly value: string }
	| { readonly id: string; readonly kind: "not-contains"; readonly path: string; readonly value: string }
	| { readonly id: string; readonly kind: "equals-expected"; readonly path: string }
	| { readonly id: string; readonly kind: "absent"; readonly path: string };

export interface FixtureManifest {
	readonly schemaVersion: 1;
	readonly id: string;
	readonly title: string;
	readonly category: FixtureCategory;
	readonly prompt: string;
	readonly security?: {
		readonly sensitivePaths?: readonly string[];
	};
	readonly compaction?: {
		readonly summary: string;
		readonly retainedUserMessage: string;
		readonly retainedAssistantMessage: string;
	};
	readonly expectedDeletePaths?: readonly string[];
	readonly acceptance: {
		readonly expectedStatus: "passed" | "failed";
		readonly requireToolRun: boolean;
		readonly checks: readonly FixtureCheck[];
	};
	readonly limits: {
		readonly maxTurns: number;
		readonly maxTools: number;
		readonly maxRepeatedToolBatches: number;
		readonly maxElapsedMs: number;
		readonly minScore: number;
	};
	readonly toolElapsedMs: number;
}

export interface TrajectoryUsage {
	readonly input: number;
	readonly output: number;
	readonly cacheRead?: number;
	readonly cacheWrite?: number;
	readonly reasoning?: number;
	readonly priceUsd: number;
}

export type TrajectoryContent =
	| { readonly type: "text"; readonly text: string }
	| {
			readonly type: "toolCall";
			readonly id: string;
			readonly name: string;
			readonly arguments: Readonly<Record<string, unknown>>;
	  };

export interface TrajectoryStep {
	readonly elapsedMs: number;
	readonly expectsContext?: readonly string[];
	readonly content: readonly TrajectoryContent[];
	readonly usage: TrajectoryUsage;
}

export interface LoadedFixture {
	readonly directory: string;
	readonly manifest: FixtureManifest;
	readonly initialFiles: Readonly<Record<string, string>>;
	readonly expectedFiles: Readonly<Record<string, string>>;
	readonly trajectory: readonly TrajectoryStep[];
}
