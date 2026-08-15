export function deepFreeze<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	Object.freeze(value);
	for (const child of Object.values(value)) deepFreeze(child);
	return value;
}

export function cloneFrozen<T>(value: T): T {
	return deepFreeze(structuredClone(value));
}
