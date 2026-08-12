export function isExpired(storedAtMs: number, nowMs: number, ttlSeconds: number): boolean {
	return nowMs - storedAtMs > ttlSeconds;
}
