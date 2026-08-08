---
status: accepted
---

# Stop effects after listener failure

Agent listeners are awaited in registration order because persistence and user visibility may be safety barriers. A listener failure prevents later model or Tool effects, while remaining listeners receive best-effort notification and `finally` cleanup guarantees `run_end` settlement and idle state; the public control failure is `AgentError("listener_failed")`.
