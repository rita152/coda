import type { ThinkingLevel } from "@coda/ai";
import type { TerminalColorScheme } from "@coda/tui";
import type { HookTrustRecord } from "../hooks/types.ts";
import type { McpServerConfiguration, WorkspaceMcpTrustRecord } from "../mcp/config.ts";
import type { ModelSelection } from "../models/model-selection.ts";
import type { CustomProviderConfig } from "../models/types.ts";

export interface ProjectTrustRecord {
	readonly workspace: string;
	readonly path: string;
	readonly sha256: string;
}

export interface UserSettings {
	readonly defaultModel?: ModelSelection;
	readonly defaultReasoning?: ThinkingLevel | "off";
	readonly customProviders?: readonly CustomProviderConfig[];
	readonly projectTrust?: readonly ProjectTrustRecord[];
	readonly mcpServers?: readonly McpServerConfiguration[];
	readonly workspaceMcpTrust?: readonly WorkspaceMcpTrustRecord[];
	readonly hookTrust?: readonly HookTrustRecord[];
	readonly ui?: {
		readonly motion?: "full" | "reduced";
		readonly colorScheme?: TerminalColorScheme;
	};
}

export interface SettingsStore {
	load(): Promise<UserSettings>;
	save(settings: UserSettings): Promise<void>;
}
