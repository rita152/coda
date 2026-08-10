# Add safe command Session Approval and harden command policy

Type: task
Status: resolved

Add process-local command-prefix Session Approval at the Permission Engine seam, executable/context binding, list/revoke support, configuration invalidation, and the agreed complex-shell and executable-rule hardening.

## Acceptance

- Only reviewed simple-command prefixes without Additional Permissions can be remembered.
- Reuse preserves Sandbox authority and validates executable identity.
- Permission configuration change, explicit revocation, or identity drift invalidates matching grants.
- Complex-shell guards and absolute executable matching fail closed as specified.
- Explicit persistent rule files remain supported.

## Answer

Added displayed model-proposed command-prefix Session Approvals bound to environment, canonical Workspace, shell, effective configuration, Sandbox request, and executable realpath/stat identity. Reuse revalidates identity; revocation, drift, and configuration changes fail closed. Complex-shell rule inspection and absolute executable matching were hardened without removing explicit persistent rule support.

## Comments
