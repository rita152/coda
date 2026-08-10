# Add Skill and MCP Extension References

Type: task
Status: resolved
Blocked by: 01, 04

Add generic Editor markers, structured Composer references, dynamic Skill/MCP registration, and Session v6 persistence without implementing an Extension loader.

## Acceptance

- Inline whitespace-boundary completion inserts a visible reference token with an opaque identity.
- Editing a token invalidates its reference; undo and draft switching preserve valid references.
- Multiple references preserve order.
- Missing loaders block submission instead of silently degrading to plain text.
- Session v1-v5 remain readable and v6 references round-trip.

## Answer

Implemented generic Editor markers, opaque ordered Skill/MCP references, invalidation and undo/draft restoration, loader-gated submission, dynamic unified registration, Prompt History preservation, and validated Session v6 persistence with v1-v5 migration coverage.
