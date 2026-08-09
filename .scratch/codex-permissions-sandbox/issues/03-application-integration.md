Type: task
Status: resolved

# Apply permissions to every model operation

Split model and User Shell execution capabilities, route process and File Tools through the new engine, add settings/CLI/TUI/print/JSON behavior, `/permissions`, and audit-only Session records, and remove the legacy permission paths.

## Comments

## Answer

Routed every model file and process operation through the Permission Engine and Sandbox, including optional search helpers and exact file mutations. Model execution and explicit `!command` User Shell execution now use distinct capabilities; the model cannot reach the unsandboxed user-shell entry point. Interactive and print modes share the same engine, with print using a rejecting reviewer.

Added settings/CLI resolution, `/permissions`, the single Full Access warning, print/JSON approval events, and audit-only Session v5 records. Transient `/permissions` authority and Session caches are never restored on cold resume, and the legacy permission system was removed. Local static checks, 575 unit tests, 3 coding-agent integration tests, and 3 CLI E2E tests passed on 2026-08-10.
