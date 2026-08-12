---
status: accepted
---

# Scope model reads to reviewed roots

Coda assigns every model-requested read one immutable Read Access Policy. In Read Only and Workspace, the ordinary readable roots are the canonical Workspace plus roots made readable by the active Permission Profile; an explicitly configured or approved Additional Permission may add a canonical root. A native File Tool request outside those roots enters filesystem review when the Approval Policy permits it and otherwise fails closed. A model-started process must declare its required root as an Additional Permission before launch because an operating-system read denial cannot safely pause the process for review. Full Access is the only full-disk read bypass.

Common Credential Roots are denied within broader readable roots by default. They include SSH, AWS, GnuPG, Kubernetes, Azure, Google Cloud, container registry, infrastructure-tool, package-manager, keyring, and environment-configured credential locations. A reviewed root overrides a Credential Root only when it is the same root or a narrower descendant; approving a broad parent does not reopen a protected child. Existing paths and their symlink targets are canonicalized, nonexistent paths are anchored to their nearest canonical existing ancestor, recursive native Tools reevaluate every canonical child, and Sandbox adapters fail closed on noncanonical policy input.

The same Read Access Policy evaluates native `read`, `grep`, `find`, and `ls` paths and carries the exact compiled policy used by model `bash`, native search helpers, and file-mutation workers. macOS Seatbelt and Linux bubblewrap enforce ordinary, approved, and denied roots with shallow-to-deep precedence. Restricted process policies expose fixed operating-system runtime support needed to launch commands, but that support is not general product-data read authority. Audit facts record requested and canonical paths, the decision, source or reason, and the effective roots; they never record denied file contents.

This ADR explicitly supersedes the full-disk-read semantics inherited by ADR-0034 and the former “filesystem is readable by default” bullets for Read Only and Workspace in `.scratch/codex-permissions-sandbox/spec.md`. ADR-0034 remains authoritative for execution capabilities, Sandbox fail-closed behavior, approvals, network policy, and the separation between model work and User Shell. Command review, Command Rules, and `require_escalated` no longer imply an unsandboxed model process under a restricted Permission Profile; precise filesystem expansion uses Additional Permissions.

## Consequences

Workspace-external native reads may now require user review, and print or otherwise noninteractive execution returns an approval-required Tool result instead of reading the path. Model-started commands that previously relied on implicit full-disk reads must retry with the narrow canonical root in `additional_permissions.file_system.read`. Permission Profile changes regenerate the Read Access Policy, while transient reviewed roots remain scoped to their Tool Invocation and never restore from Session audit records.
