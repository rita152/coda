---
status: accepted
---

# Enforce runtime and application module boundaries

ADR-0049 supersedes this decision's repository-wide `@coda/ai` Time ownership clause. ADR-0050 supersedes its hand-maintained build and boundary-enforcement mechanism. ADR-0055 supersedes the eight-package count; the dependency direction remains accepted.

Coda keeps a closed workspace DAG and applies the direction “applications may know foundations; foundations never know applications.” `ai` owns Provider, API, Credential, Model, Catalog, and Time vocabulary; `agent` owns the serial Agent kernel; `runtime` owns the complete headless Work Graph product; `evals` proves that product without depending on `coding-agent`; and `coding-agent` owns the physical host and application composition. In particular, `runtime` depends exactly on `agent` and `ai` and cannot know paths, processes, shells, terminals, credentials, MCP servers, Skills, or UI.

The runtime Work Coordinator is a contract adapter rather than an owner of mechanisms. Work Graph records and Aggregate projection, Observation fan-out, durable Graph storage, Session leases, admission fairness, Worker lifecycle, recovery, Publication sequencing, and state-machine progression have named internal owners. Persistent Work Graph fields are projected only from `WorkGraphAggregate.snapshot()` after `DurableGraphStore.appendFacts` applies and appends a Fact segment. The only exceptions are explicitly documented process-local fail-stop settlements whose durability is `unknown`.

Runtime dependencies cross named ports using provider vocabulary. Time is the single `@coda/ai` `TimeRuntime`; model resolution and driver leasing form one `RunModelProvider`; Workspace Placement, Tooling, and Publication are separate capabilities; and physical persistence receives opaque restore and commit values. The Work Graph Fact algebra and Aggregate never cross the persistence port. The runtime persistence codec owns both the Workspace Ledger and Work Graph Store line formats; the Coding Agent filesystem adapter merely stores those opaque values.

`coding-agent` owns two composition roots: the process application and the Workspace agent adapter. Its internal modules are `app`, `ui`, `session`, `session-history`, `tools`, `runtime`, `models`, `skills`, `mcp`, `credentials`, `run-evidence`, `commands`, `run-control`, `completion`, `process`, `media`, `settings`, `host`, and `maintenance`. UI consumes projections and the `SessionWorkController` interface, Tools consume the read-only Session History port, and only the Interactive Input Adapter may write a Session. Biome and the repository boundary checker make these directions executable.

Session journals remain in `coding-agent/session`. They embed application-only concepts including project and MCP trust, Composer Submissions, Media Assets, Run Evidence, and Model Selection. Moving Session into `agent` or `runtime` was rejected because it would make a foundation depend on application vocabulary; adding a ninth package was rejected by the package constraint. Runtime therefore sees only the opaque `WorkerSession` and `WorkSessionStore` protocol.

This decision deepens ADR-0046 without changing Coding Agent commands, observations, scheduling fairness, Publication order, persistence backends, or the public `submit`/`observe`/`close` contract.
