# Add Plugin enablement and deterministic selection

Type: task
Status: resolved
Priority: P0

Make installed, enabled, valid, trusted, and selected distinct client states.
Resolve those states before Plugin components enter the existing Skill and MCP
seams.

## Dependencies

- Issue 01 supplies durable Plugin Installation identities and source state.

## Acceptance

- A completed new installation is enabled by default, and enable/disable is
  persisted against its installation identity rather than its path.
- Disabled installations contribute no Prompt fragment, Skill Candidate, MCP
  Server Definition, process, palette entry, or model-visible Tool.
- Workspace/user precedence and duplicate-name handling are deterministic. An
  explicitly disabled selected Workspace installation blocks fallback to a
  same-name user installation.
- Invalidity, disablement, Project Trust, and MCP Server Trust cannot substitute
  for one another and remain independently diagnosable.
- Enablement changes update Desired Runtime Configuration for a later Run and
  never alter an active Prepared Run.
- Settings parse, validation, persistence, migration, and unknown-key behavior
  have focused tests, including disable/re-enable across process restart.
- A live HTTPS-installed Plugin is enabled, disabled, and re-enabled; each next
  Run's prompt, Skill list, MCP list, and process state are recorded under
  `## Comments` before resolution.

## Ownership

Keep enablement in Coding Agent settings and Plugin client policy. Package
validity stays in `@coda/plugins`; MCP trust stays at the existing application
trust seam.

## Comments

- 2026-08-19 offline evidence: `management.test.ts` covers enabled-by-default
  installation, disable persistence across restart, re-enable, removal, update
  without enablement drift, and atomic settings failure. `inventory.test.ts`
  keeps installed, enabled, valid, selected, and trusted state separate; it
  proves that an explicitly disabled selected Workspace installation does not
  fall back to an enabled lower-precedence copy. `project-runtime.test.ts`
  switches Plugin guidance, Skill, MCP, and process projection together for a
  later Run while preserving the active Run lease.
- 2026-08-19 network evidence already observed through the official example
  proves managed installation and effective enabled Skill/MCP projection. The
  current live harness additionally encodes disable, empty disabled Inventory,
  re-enable, upgrade without losing disablement, two restart boundaries, and
  removal. Those expanded scenarios still need one final timed rerun before
  resolution.
- 2026-08-20 final evidence: the live run observed enabled installation,
  disabled Inventory with no Plugin prompt/Skill/MCP contribution, re-enable,
  upgrade without enablement drift, installed-state restart, removal, and
  post-removal restart. The active Run retained its frozen state while later
  Runs followed the new setting. Transactional settings and concurrent Plugin
  writes passed in the complete offline suite; exact sealing commands and times
  are in [`../conformance.md`](../conformance.md).
