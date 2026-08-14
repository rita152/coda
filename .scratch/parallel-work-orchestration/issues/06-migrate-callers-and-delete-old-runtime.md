# Migrate all callers and delete the old Runtime surface

Status: resolved
Blocked by: 03, 04, 05

Move interactive, print, eval, secondary Session, and completion/evidence flows to the new public Seam. Remove old factories, duplicate Runtime maps, RuntimeInputLifecycle exposure, executable snapshots, obsolete tests, aliases, and dead composition code. Update capability reporting and architecture documentation.

## Comments

- Migrated interactive, print, eval, secondary Session, completion, evidence, MCP elicitation, and RunControl paths to `openCodingAgent()`. Presentation projections use the isolated public Observation seam; bounded completion repair is an ordered, failure-isolated Worker Control hook that submits Steering back through the same public command path.
- Post-review: removed the construction-only `observeWorkerEvent` callback. Application and evaluation projections now consume data-only `work_item_event` values through `CodingAgent.observe()`, while post-Publication result projections collect the final source Workspace evidence without re-entering Runtime barriers.
- Post-review: staged Attachment transactions are registered in one Workspace input-resource Adapter and transferred to Runtime reserve/commit/rollback during command acceptance; the UI retains only pre-reservation rejection cleanup.
- Replaced duplicate primary/secondary Runtime maps with foreground-only `WorkspaceSessionPanes`; simultaneous Sessions share one Workspace Work Coordinator while retaining isolated Worker Runtime, Session, and transcript ownership.
- Deleted `openAgentRuntime`, `openCodingAgentRuntime`, `CodingAgentRuntime`, `RuntimeInputLifecycle`, `RuntimeInputQueue`, their factories, compatibility types, dead composition modules, and obsolete tests. Worker preparation, input envelopes, Context Window control, Skills/MCP snapshots, and serial Agent execution remain private to `@coda/runtime`.
- Node composition now injects the durable File Work Journal; in-memory application composition uses the Runtime memory Journal. Restored Compaction Checkpoints cross the Session Adapter correctly.
- Removed the incompatible public `/compact` entry point and dead manual queue while retaining automatic/private Worker compaction and durable checkpoints. Updated capabilities, README, domain language, and ADR-0038.
- Fixed background Process lease reentrancy: Process control calls reuse the retained Workspace lease while unrelated read/write work remains blocked until Process settlement.
- Verification at issue resolution: runtime, coding-agent, and eval builds/typechecks passed; the final issue-07 repository matrix supersedes the interim test counts recorded here.
