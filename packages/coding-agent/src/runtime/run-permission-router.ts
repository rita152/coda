import type { PermissionEngine } from "../permissions/permission-engine.ts";
import type { RunRuntimeSlot } from "./run-runtime-slot.ts";

/** Delegates every permission operation to the immutable runtime chosen for the active Run. */
export class RunPermissionRouter<T> implements PermissionEngine {
	readonly #slot: RunRuntimeSlot<T>;
	readonly #permissionFor: (value: T) => PermissionEngine;

	constructor(slot: RunRuntimeSlot<T>, permissionFor: (value: T) => PermissionEngine) {
		this.#slot = slot;
		this.#permissionFor = permissionFor;
	}

	check(...parameters: Parameters<PermissionEngine["check"]>): ReturnType<PermissionEngine["check"]> {
		return this.#current().check(...parameters);
	}

	authorizationFor(
		...parameters: Parameters<PermissionEngine["authorizationFor"]>
	): ReturnType<PermissionEngine["authorizationFor"]> {
		return this.#current().authorizationFor(...parameters);
	}

	readAccessPolicyFor(
		...parameters: Parameters<PermissionEngine["readAccessPolicyFor"]>
	): ReturnType<PermissionEngine["readAccessPolicyFor"]> {
		return this.#current().readAccessPolicyFor(...parameters);
	}

	configuration(): ReturnType<PermissionEngine["configuration"]> {
		return this.#current().configuration();
	}

	update(...parameters: Parameters<PermissionEngine["update"]>): ReturnType<PermissionEngine["update"]> {
		return this.#selected().update(...parameters);
	}

	approvalFor(
		...parameters: Parameters<PermissionEngine["approvalFor"]>
	): ReturnType<PermissionEngine["approvalFor"]> {
		return this.#current().approvalFor(...parameters);
	}

	listSessionApprovals(): ReturnType<PermissionEngine["listSessionApprovals"]> {
		return this.#selected().listSessionApprovals();
	}

	revokeSessionApproval(
		...parameters: Parameters<PermissionEngine["revokeSessionApproval"]>
	): ReturnType<PermissionEngine["revokeSessionApproval"]> {
		return this.#selected().revokeSessionApproval(...parameters);
	}

	revokeAllSessionApprovals(): ReturnType<PermissionEngine["revokeAllSessionApprovals"]> {
		return this.#selected().revokeAllSessionApprovals();
	}

	consumeAbort(
		...parameters: Parameters<PermissionEngine["consumeAbort"]>
	): ReturnType<PermissionEngine["consumeAbort"]> {
		return this.#current().consumeAbort(...parameters);
	}

	requestGenericApproval(
		...parameters: Parameters<PermissionEngine["requestGenericApproval"]>
	): ReturnType<PermissionEngine["requestGenericApproval"]> {
		return this.#current().requestGenericApproval(...parameters);
	}

	#current(): PermissionEngine {
		return this.#permissionFor(this.#slot.active?.value ?? this.#slot.selected);
	}

	#selected(): PermissionEngine {
		return this.#permissionFor(this.#slot.selected);
	}
}
