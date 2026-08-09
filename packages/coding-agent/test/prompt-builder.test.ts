import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../src/prompt/prompt-builder.ts";

describe("versioned System Prompt Builder", () => {
	it("builds a deterministic snapshot from explicit Workspace, capability, and trusted-project facts", () => {
		const input = {
			workspace: "/workspace/project",
			platform: "darwin" as const,
			timestamp: 1_800_000_000_000,
			tools: [
				{ name: "write", description: "Write a file" },
				{ name: "read", description: "Read a file" },
			],
			capabilities: {
				interactionMode: "print" as const,
				permissionProfile: "read-only" as const,
				approvalPolicy: "on-request",
			},
			projectInstructions: {
				path: "/workspace/project/AGENTS.md",
				sha256: "abc123",
				content: "Use strict TypeScript.\n",
			},
		};

		const first = buildSystemPrompt(input);
		const second = buildSystemPrompt(structuredClone(input));

		expect(first).toEqual(second);
		expect(first.version).toBe("coda-system-prompt-v2");
		expect(first.sha256).toMatch(/^[a-f0-9]{64}$/);
		expect(first.text).toContain("Workspace: /workspace/project");
		expect(first.text.indexOf("- read: Read a file")).toBeLessThan(first.text.indexOf("- write: Write a file"));
		expect(first.text).toContain("BEGIN TRUSTED PROJECT INSTRUCTIONS");
		expect(first.text).toContain("SHA-256: abc123");
	});

	it("rejects project instructions larger than 64 KiB instead of truncating them", () => {
		expect(() =>
			buildSystemPrompt({
				workspace: "/workspace",
				platform: "darwin",
				timestamp: 0,
				tools: [],
				capabilities: {
					interactionMode: "print",
					permissionProfile: "read-only",
					approvalPolicy: "on-request",
				},
				projectInstructions: {
					path: "/workspace/AGENTS.md",
					sha256: "hash",
					content: "x".repeat(64 * 1024 + 1),
				},
			}),
		).toThrow("64 KiB");
	});
});
