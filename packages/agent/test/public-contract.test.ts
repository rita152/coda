import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import * as publicApi from "../src/index.ts";
import { Agent, AgentError, type AgentTool, type QueueItemId } from "../src/index.ts";
import { baseOptions, TestIds } from "./helpers.ts";
import { composeAgent, consumeRun } from "./public-types.consumer.ts";

describe("@coda/agent public package contract", () => {
	it("exports only the Milestone 1 runtime values from the root", () => {
		expect(Object.keys(publicApi).sort()).toEqual(["Agent", "AgentError"]);
		expect(typeof composeAgent).toBe("function");
		expect(typeof consumeRun).toBe("function");
	});

	it("publishes only its root entry and depends on no Coda package except @coda/ai", async () => {
		const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
			private: boolean;
			exports: Record<string, unknown>;
			dependencies?: Record<string, string>;
		};

		expect(packageJson.private).toBe(true);
		expect(Object.keys(packageJson.exports)).toEqual(["."]);
		expect(packageJson.dependencies).toEqual({ "@coda/ai": "0.1.0" });
	});

	it("uses stable AgentError codes for control-plane failures", () => {
		const agent = new Agent(baseOptions([]));
		expect(() => agent.prompt("   ")).toThrowError(AgentError);
		try {
			agent.prompt("   ");
		} catch (error) {
			expect(error).toMatchObject({ code: "invalid_input" });
		}
		expect(() => agent.cancelQueueItem("unknown" as QueueItemId)).toThrowError(AgentError);
		try {
			agent.cancelQueueItem("unknown" as QueueItemId);
		} catch (error) {
			expect(error).toMatchObject({ code: "queue_item_not_found" });
		}

		const duplicate: AgentTool = {
			name: "duplicate",
			description: "duplicate",
			parameters: { type: "object" },
			replaySafety: "never",
			execute: () => ({ content: "unused" }),
		};
		expect(() => new Agent({ ...baseOptions([]), tools: [duplicate, duplicate] })).toThrowError(AgentError);
	});

	it("fails closed when an IdGenerator repeats an identity", () => {
		class DuplicateIds extends TestIds {
			override generate(): string {
				return "same";
			}
		}
		const agent = new Agent(baseOptions([], { ids: new DuplicateIds() }));
		expect(() => agent.prompt("allocate")).toThrowError(AgentError);
		try {
			agent.prompt("allocate");
		} catch (error) {
			expect(error).toMatchObject({ code: "invalid_lifecycle" });
		}
		expect(agent.state.status).toBe("idle");
	});

	it("fails closed when an IdGenerator returns an identity unsafe for persistence", () => {
		class UnsafeIds extends TestIds {
			#next = 0;

			override generate(kind: Parameters<TestIds["generate"]>[0]): string {
				return `${kind}\n${++this.#next}`;
			}
		}
		const agent = new Agent(baseOptions([], { ids: new UnsafeIds() }));

		expect(() => agent.prompt("allocate")).toThrowError(AgentError);
		try {
			agent.prompt("allocate");
		} catch (error) {
			expect(error).toMatchObject({ code: "invalid_lifecycle" });
		}
		expect(agent.state.status).toBe("idle");
	});
});
