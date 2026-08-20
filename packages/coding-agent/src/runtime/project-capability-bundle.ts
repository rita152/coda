import type { CodingMcpToolLease } from "../mcp/registry.ts";
import type { CodingPluginsSnapshot } from "../plugins/types.ts";
import type { CodingSkillsSnapshot } from "../skills/types.ts";

/** One coherent Project view retained for the lifetime of a Prepared Run. */
export interface ProjectRunCapabilityBundle {
	readonly revision: string;
	readonly plugins: CodingPluginsSnapshot;
	readonly skills: CodingSkillsSnapshot;
	readonly mcp: CodingMcpToolLease;
	dispose(): Promise<void> | void;
}

export type AcquireProjectRunCapabilityBundle = (
	signal: AbortSignal,
) => ProjectRunCapabilityBundle | Promise<ProjectRunCapabilityBundle>;
