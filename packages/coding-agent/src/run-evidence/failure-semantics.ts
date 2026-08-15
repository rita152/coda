import { createHash } from "node:crypto";
import { deepFreeze } from "@coda/agent";
import type { RunEvidenceFailure, RunEvidenceRecoveredFailure } from "./contracts.ts";

export type FailureResolutionEvent =
	| {
			readonly sequence: number;
			readonly failure: RunEvidenceFailure;
			readonly resolutionScope?: string;
	  }
	| {
			readonly sequence: number;
			readonly recoveredById: string;
			readonly resolutionScopes: readonly string[];
	  };

interface OpenFailureState {
	readonly failure: RunEvidenceFailure;
	readonly resolutionScope?: string;
}

export function reconcileFailures(events: readonly FailureResolutionEvent[]): {
	readonly recoveredFailures: readonly RunEvidenceRecoveredFailure[];
	readonly openFailures: readonly RunEvidenceFailure[];
} {
	const keyed = new Map<string, OpenFailureState>();
	const unkeyed: RunEvidenceFailure[] = [];
	const recovered: RunEvidenceRecoveredFailure[] = [];
	const ordered = [...events].sort((left, right) => left.sequence - right.sequence);
	for (const event of ordered) {
		if ("failure" in event) {
			if (!event.failure.resolutionKey) {
				unkeyed.push(event.failure);
				continue;
			}
			keyed.set(event.failure.resolutionKey, {
				failure: event.failure,
				...(event.resolutionScope ? { resolutionScope: event.resolutionScope } : {}),
			});
			continue;
		}
		const scopes = new Set(event.resolutionScopes);
		for (const [key, open] of keyed) {
			if (!open.resolutionScope || !scopes.has(open.resolutionScope)) continue;
			recovered.push(
				deepFreeze({
					...open.failure,
					recoveredById: event.recoveredById,
					recoveredAtSequence: event.sequence,
				}),
			);
			keyed.delete(key);
		}
	}
	return deepFreeze({
		recoveredFailures: recovered.sort((left, right) => left.recoveredAtSequence - right.recoveredAtSequence),
		openFailures: [...unkeyed, ...[...keyed.values()].map(({ failure }) => failure)].sort(
			(left, right) => left.sequence - right.sequence,
		),
	});
}

export function commandResolutionKey(command: string): string {
	return resolutionScope("command", normalizeRunEvidenceCommand(command));
}

/**
 * Stable normalization used only for exact command identity, never for Shell execution.
 * Internal whitespace remains byte-significant because collapsing it can change quoted Shell input.
 */
export function normalizeRunEvidenceCommand(command: string): string {
	return command.replace(/\r\n?/gu, "\n").trim();
}

export function resolutionScope(kind: string, value: string): string {
	return `${kind}:v1:${createHash("sha256").update(value).digest("hex")}`;
}
