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
		expect(first.version).toBe("coda-system-prompt-v8");
		expect(first.sha256).toMatch(/^[a-f0-9]{64}$/);
		expect(first.text).toContain("Workspace: /workspace/project");
		expect(first.text.indexOf("- read: Read a file")).toBeLessThan(first.text.indexOf("- write: Write a file"));
		expect(first.text).toContain("BEGIN TRUSTED PROJECT INSTRUCTIONS");
		expect(first.text).toContain("SHA-256: abc123");
		expect(first.text).toContain("File Tools resolve relative paths from the Workspace");
		expect(first.text).toContain("Bash and process_start execute directly on the host as the current user");
		expect(first.text).toContain("Turn every stated requirement into an implementation and verification checklist");
		expect(first.text).toContain("Run the broadest feasible regression suite after the final edit");
		expect(first.text).toContain("Do not claim a check passed unless you actually ran it successfully");
		expect(first.text).toContain(
			"Do not filter verification commands through a pipeline that can hide an upstream failure",
		);
	});

	it("renders opaque Prompt fragments in deterministic id order", () => {
		const result = buildSystemPrompt({
			workspace: "/workspace",
			platform: "darwin",
			timestamp: 0,
			tools: [],
			capabilities: {
				interactionMode: "print",
			},
			fragments: [
				{ id: "zeta", text: "ZETA CONTRIBUTION" },
				{ id: "alpha", text: "ALPHA CONTRIBUTION" },
			],
		});

		expect(result.text.indexOf("ALPHA CONTRIBUTION")).toBeLessThan(result.text.indexOf("ZETA CONTRIBUTION"));
	});

	it("rejects duplicate Prompt fragment identities", () => {
		expect(() =>
			buildSystemPrompt({
				workspace: "/workspace",
				platform: "darwin",
				timestamp: 0,
				tools: [],
				capabilities: { interactionMode: "print" },
				fragments: [
					{ id: "duplicate", text: "one" },
					{ id: "duplicate", text: "two" },
				],
			}),
		).toThrow("Duplicate or empty Prompt fragment id");
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
				},
				projectInstructions: {
					path: "/workspace/AGENTS.md",
					sha256: "hash",
					content: "x".repeat(64 * 1024 + 1),
				},
			}),
		).toThrow("64 KiB");
	});

	it("omits empty Prompt fragments", () => {
		const result = buildSystemPrompt({
			workspace: "/workspace",
			platform: "darwin",
			timestamp: 0,
			tools: [],
			capabilities: {
				interactionMode: "print",
			},
			fragments: [{ id: "empty", text: "" }],
		});

		expect(result.text).not.toContain("empty");
	});
});
