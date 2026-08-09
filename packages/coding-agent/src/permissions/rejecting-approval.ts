import type { ApprovalDecision, PermissionApprovalHandler, PermissionApprovalRequest } from "./permission-engine.ts";

export class RejectingApprovalHandler implements PermissionApprovalHandler {
	#requests: PermissionApprovalRequest[] = [];
	readonly #onRequest?: (request: PermissionApprovalRequest) => void | Promise<void>;

	constructor(onRequest?: (request: PermissionApprovalRequest) => void | Promise<void>) {
		this.#onRequest = onRequest;
	}

	get requests(): readonly PermissionApprovalRequest[] {
		return Object.freeze([...this.#requests]);
	}

	async decide(request: PermissionApprovalRequest): Promise<ApprovalDecision> {
		this.#requests.push(request);
		await this.#onRequest?.(request);
		return { type: "denied", rejection: "approval is unavailable in print mode" };
	}
}
