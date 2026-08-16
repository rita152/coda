import type { SessionRecord } from "./records.ts";

/**
 * Setup choices may be recorded before the user starts any resumable work. They
 * remain provisional until another semantic fact commits the Session history.
 */
export function isProvisionalSessionRecord(record: SessionRecord): boolean {
	switch (record.type) {
		case "model_selected":
		case "project_trust_changed":
		case "mcp_trust_changed":
			return true;
		default:
			return false;
	}
}

/** Conservatively retains every current or future semantic fact except known setup-only choices. */
export function hasRetainedSessionActivity(records: readonly SessionRecord[]): boolean {
	return records.some((record) => !isProvisionalSessionRecord(record));
}
