---
status: accepted
---

# Persist only the Session Permission Selection

A Session persists the user's selected built-in Permission Profile so returning to that Session restores the intended high-level posture, while each Run freezes the resolved Permission Engine before model work begins. This deliberately supersedes ADR-0024's blanket exclusion of restored transient profiles and ADR-0034's statement that every `/permissions` override is process-local: Permission audit facts, Additional Permissions, Session Approvals, rules, and Sandbox outcomes still never restore authority.
