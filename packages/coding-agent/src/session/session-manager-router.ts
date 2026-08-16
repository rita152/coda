import { summarizeSessionRecords } from "./session-summary.ts";
import type {
	OpenSessionRequest,
	Session,
	SessionDescriptor,
	SessionManager,
	SessionSummary,
	SessionWorkspace,
} from "./types.ts";

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

	async listSummaries(workspace: SessionWorkspace): Promise<readonly SessionSummary[]> {
		if (this.#persistent.listSummaries) return this.#persistent.listSummaries(workspace);
		return (await this.#persistent.list(workspace)).map((descriptor) => summarizeSessionRecords(descriptor, []));
	}
}
