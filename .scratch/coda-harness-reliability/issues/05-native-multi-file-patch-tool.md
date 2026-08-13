# Add a permission-aware multi-file patch Tool

Type: task
Status: ready-for-agent
Priority: P1

Add a structured, multi-hunk/multi-file native patch Tool so common edits use Coda's containment and emit mutation facts. Centralize mutation metadata so permission review, evidence, presentation, and capability manifests do not each hard-code `edit | write | patch` independently.

## Acceptance

- One invocation supports add/update/delete and multiple hunks/files, preserving newline/BOM and reporting every changed path.
- All targets and preconditions are parsed, authorized, and verified before writes; reject traversal, protected metadata, symlink swaps, conflicts, and content races.
- Each file write is atomic. If reliable cross-file rollback is not implemented, failure explicitly reports applied/not-applied paths and never claims global atomicity.
- Permission review shows a bounded patch preview and authorizes exactly the target set.
- RunEvidence consumes generic mutation facts, while a final workspace diff supplements paths changed through Shell; provenance is visible.
- Existing edit/write stay compatible; Tool ordering, model description, TUI presentation, capability contract, and race tests are updated.

## Ownership and dependencies

Rebase onto issue 08's evidence contract and issue 01's Tool registry state. Study Codex/OpenCode/Grok Build apply-patch parser, preflight, diff tracking, and permission integration; do not copy code without license/architecture review.
