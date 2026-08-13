---
status: accepted
---

# Restore only idle Agent Seeds

Session recovery constructs a versioned Agent Seed containing committed Messages and pending Follow-ups only after resolving interrupted Tool state and validating relationships. Models, Credentials, active Runs, Attempts, Steering, processes, and persistence details stay outside the Seed, so a restored Agent always starts idle through its normal Interface.
