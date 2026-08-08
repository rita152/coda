const PERSISTENCE_SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u;

export function isPersistenceSafeId(value: unknown): value is string {
	return typeof value === "string" && PERSISTENCE_SAFE_ID.test(value);
}
