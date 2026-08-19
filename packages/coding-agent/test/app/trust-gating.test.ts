import { describe, expect, it } from "vitest";
import { mcpTrustDecision } from "../../src/app/trust-gating.ts";

describe("mcpTrustDecision", () => {
	it("replaces trust only for the same workspace MCP source path", () => {
		const workspace = "/workspace";
		const native = { workspace, path: "/workspace/.coda/mcp.json", sha256: "a".repeat(64) };
		const stalePlugin = {
			workspace,
			path: "/workspace/.agents/plugins/tools/mcp.json",
			sha256: "b".repeat(64),
		};
		const decision = mcpTrustDecision({
			workspace,
			snapshot: {
				path: stalePlugin.path,
				sha256: "c".repeat(64),
				trust: "untrusted",
				serverCount: 1,
				servers: [],
			},
			settings: { workspaceMcpTrust: [stalePlugin, native] },
			authorized: true,
		});

		expect(decision.updatedSettings?.workspaceMcpTrust).toEqual([
			{ workspace, path: stalePlugin.path, sha256: "c".repeat(64) },
			native,
		]);
	});
});
