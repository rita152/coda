import { createHash } from "node:crypto";
import type { AgentInput, Immutable } from "@coda/agent";
import type { CodingSkillsSnapshot } from "./types.ts";

function inputKey(input: AgentInput | Immutable<AgentInput>): string {
	return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

/** Associates a prepared explicit-reference payload with the exact future Run input. */
export class RunSkillsCoordinator {
	readonly #prepared = new Map<string, CodingSkillsSnapshot[]>();
	#nextBinding = 0;

	createBinding(): string {
		return `coda-skill-snapshot:${++this.#nextBinding}`;
	}

	prepare(input: AgentInput, snapshot: CodingSkillsSnapshot, binding: string): void {
		if (!binding || !JSON.stringify(input).includes(binding)) {
			throw new Error("Prepared Skill input must contain its unique snapshot binding");
		}
		const key = inputKey(input);
		const queue = this.#prepared.get(key) ?? [];
		queue.push(snapshot);
		this.#prepared.set(key, queue);
	}

	consume(input: Immutable<AgentInput>): CodingSkillsSnapshot | undefined {
		const key = inputKey(input);
		const queue = this.#prepared.get(key);
		const snapshot = queue?.shift();
		if (queue?.length === 0) this.#prepared.delete(key);
		return snapshot;
	}
}
