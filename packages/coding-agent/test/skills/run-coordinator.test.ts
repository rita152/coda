import type { AgentInput, Immutable } from "@coda/agent";
import { describe, expect, it } from "vitest";
import { RunSkillsCoordinator } from "../../src/skills/run-coordinator.ts";
import type { CodingSkillsSnapshot } from "../../src/skills/types.ts";

describe("RunSkillsCoordinator", () => {
	it("uses a unique in-band binding so an abandoned identical activation cannot steal a later snapshot", () => {
		const coordinator = new RunSkillsCoordinator();
		const first = { inventory: { sha256: "first" } } as CodingSkillsSnapshot;
		const second = { inventory: { sha256: "second" } } as CodingSkillsSnapshot;
		const firstBinding = coordinator.createBinding();
		const firstInput = `context ${firstBinding}\nsame task`;
		coordinator.prepare(firstInput, first, firstBinding);
		const secondBinding = coordinator.createBinding();
		const secondInput = `context ${secondBinding}\nsame task`;
		coordinator.prepare(secondInput, second, secondBinding);

		expect(coordinator.consume(secondInput as Immutable<AgentInput>)).toBe(second);
		expect(coordinator.consume(firstInput as Immutable<AgentInput>)).toBe(first);
	});

	it("rejects a prepared input that lost its binding", () => {
		const coordinator = new RunSkillsCoordinator();
		const binding = coordinator.createBinding();

		expect(() => coordinator.prepare("task", {} as CodingSkillsSnapshot, binding)).toThrow("must contain");
	});
});
