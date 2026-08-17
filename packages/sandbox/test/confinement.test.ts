import { describe, expect, it } from "vitest";
import {
	filesystemAccessForSandboxMode,
	openProcessConfinement,
	ProcessConfinementError,
	processConfinementActive,
	resolvedConfinementConfig,
} from "../src/index.ts";
import type { ProcessConfinementConfig, ProcessConfinementEngine } from "../src/types.ts";

function recordingEngine(initialized: ProcessConfinementConfig[]): ProcessConfinementEngine {
	return {
		initialize: async (config) => {
			initialized.push(config);
		},
		wrapScript: async (request) => ({
			executable: request.shell,
			args: ["-c", `confined:${request.command}`],
			environment: { ...request.environment, SANDBOX_RUNTIME: "1" },
		}),
		close: async () => undefined,
	};
}

describe("Process Confinement", () => {
	it("defaults workspace-write to Workspace plus /tmp, and protects Coda metadata paths", async () => {
		const initialized: ProcessConfinementConfig[] = [];
		const confinement = await openProcessConfinement({
			platform: "darwin",
			config: { workspace: "/workspace" },
			engine: recordingEngine(initialized),
		});
		expect(initialized).toEqual([
			{
				workspace: "/workspace",
				mode: "workspace-write",
				allowWrite: ["/workspace", "/tmp"],
				denyWrite: ["/workspace/.git", "/workspace/.agents", "/workspace/.coda"],
				denyRead: [],
				allowedDomains: [],
				deniedDomains: [],
			},
		]);
		await expect(
			confinement.wrapScript({
				command: "npm test",
				shell: "/bin/zsh",
				cwd: "/workspace",
				environment: { PATH: "/usr/bin" },
				commandId: "tool-1",
			}),
		).resolves.toEqual({
			executable: "/bin/zsh",
			args: ["-c", "confined:npm test"],
			environment: { PATH: "/usr/bin", SANDBOX_RUNTIME: "1" },
		});
		await confinement.close();
	});

	it("uses an empty allowWrite list for read-only and refuses danger-full-access", () => {
		expect(resolvedConfinementConfig({ workspace: "/workspace", mode: "read-only" })).toEqual({
			workspace: "/workspace",
			mode: "read-only",
			allowWrite: [],
			denyWrite: [],
			denyRead: [],
			allowedDomains: [],
			deniedDomains: [],
		});
		expect(() => resolvedConfinementConfig({ workspace: "/workspace", mode: "danger-full-access" })).toThrow(
			ProcessConfinementError,
		);
		expect(processConfinementActive("read-only")).toBe(true);
		expect(processConfinementActive("workspace-write")).toBe(true);
		expect(processConfinementActive("danger-full-access")).toBe(false);
		expect(filesystemAccessForSandboxMode("read-only")).toBe("restricted");
		expect(filesystemAccessForSandboxMode("danger-full-access")).toBe("unrestricted");
	});

	it("rejects Windows and relative Workspace paths", async () => {
		const fake = recordingEngine([]);
		await expect(
			openProcessConfinement({
				platform: "win32",
				config: { workspace: "C:\\workspace" },
				engine: fake,
			}),
		).rejects.toMatchObject({ code: "unsupported-platform" });
		await expect(
			openProcessConfinement({
				platform: "linux",
				config: { workspace: "workspace" },
				engine: fake,
			}),
		).rejects.toBeInstanceOf(ProcessConfinementError);
	});
});
