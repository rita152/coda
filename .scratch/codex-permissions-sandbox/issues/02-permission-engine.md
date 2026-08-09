Type: task
Status: resolved

# Replace the Coding Agent Policy Gate

Implement presets, four Approval Policies, exact Additional Permissions, command parsing/classification, rules, Session caches, managed host decisions, explicit escalation, rejection, and abort through the Coding Agent seam.

## Comments

## Answer

Replaced the legacy gate with a single Permission Engine implementing Read Only, Workspace, and Full Access profiles; Unless Trusted, On Request, Granular, and Never approval policies; the three model elevation modes; exact Additional Permissions; process-local approvals; command and network rules; rejection, abort, and timeout outcomes; and generic Skill/MCP protocol surfaces.

Command rules retain Codex's pure-command aggregation and complex-shell fallback behavior, while dangerous-command detection examines literal commands inside nested shell syntax. Managed-network decisions are normalized and scoped by environment, host, protocol, and port. The unified permission matrix and focused rule/cache/protocol tests passed as part of the 575-test local unit suite on 2026-08-10.
