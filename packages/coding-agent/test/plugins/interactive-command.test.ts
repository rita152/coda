import { describe, expect, it, vi } from "vitest";
import type { PluginsCommand } from "../../src/app/plugin-management.ts";
import type { CommandFlowOpener, CommandFlowScreen } from "../../src/commands/flow-types.ts";
import { openPluginsCommand } from "../../src/ui/run-interactive.ts";

describe("interactive /plugins", () => {
	it("opens the source-aware Plugin detail using the live management snapshot", async () => {
		const snapshot = {
			revision: "plugins:1",
			plugins: [
				{
					pluginId: "review-tools@team" as const,
					displayName: "Review Tools",
					state: "enabled" as const,
					installedVersion: "1.0.0",
				},
			],
			diagnostics: [],
		};
		const command: PluginsCommand = {
			snapshot: vi.fn(async () => snapshot),
			install: vi.fn(async () => snapshot),
			enable: vi.fn(async () => snapshot),
			disable: vi.fn(async () => snapshot),
			upgrade: vi.fn(async () => snapshot),
			remove: vi.fn(async () => snapshot),
			refresh: vi.fn(async () => snapshot),
		};
		let opened: CommandFlowScreen | undefined;
		const flow: CommandFlowOpener = {
			open: (menu) => {
				opened = menu;
			},
		};

		await openPluginsCommand(flow, " review-tools@team ", command);

		expect(command.snapshot).toHaveBeenCalledOnce();
		expect(opened).toMatchObject({
			id: "plugins:detail:review-tools@team",
			title: "Review Tools",
		});
	});
});
