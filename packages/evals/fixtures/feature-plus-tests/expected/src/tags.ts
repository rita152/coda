export function normalizeTag(value: string): string {
	return value.trim().toLowerCase();
}

export function uniqueTags(values: readonly string[]): string[] {
	const result: string[] = [];
	for (const value of values) {
		const normalized = normalizeTag(value);
		if (!result.includes(normalized)) result.push(normalized);
	}
	return result;
}
