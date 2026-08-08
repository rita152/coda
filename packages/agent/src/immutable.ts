import type { Immutable } from "./types.ts";

export function deepFreeze<T>(value: T): Immutable<T> {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value as Immutable<T>;
	Object.freeze(value);
	for (const child of Object.values(value)) deepFreeze(child);
	return value as Immutable<T>;
}

export function cloneFrozen<T>(value: T): Immutable<T> {
	return deepFreeze(structuredClone(value));
}
