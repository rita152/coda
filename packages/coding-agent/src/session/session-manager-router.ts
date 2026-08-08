import type { OpenSessionRequest, Session, SessionDescriptor, SessionManager, SessionWorkspace } from "./types.ts";

export class SessionManagerRouter implements SessionManager {
	readonly #memory: SessionManager;
	readonly #persistent: SessionManager;

	constructor(memory: SessionManager, persistent: SessionManager) {
		this.#memory = memory;
		this.#persistent = persistent;
	}

	open(request: OpenSessionRequest): Promise<Session> {
		return (request.persistent || request.resumeId ? this.#persistent : this.#memory).open(request);
	}

	list(workspace: SessionWorkspace): Promise<readonly SessionDescriptor[]> {
		return this.#persistent.list(workspace);
	}
}
