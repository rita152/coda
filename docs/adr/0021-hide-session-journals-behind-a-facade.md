---
status: accepted
---

# Hide Session Journals behind a deep Module

Coding Agent callers open a high-level Session that yields a validated Agent Seed, observes one attached Agent, records application changes, and closes ownership. JSONL records, locks, corruption recovery, and file versus in-memory Session Journal Adapters remain behind a private seam, concentrating persistence complexity instead of requiring every caller to understand the log format.
