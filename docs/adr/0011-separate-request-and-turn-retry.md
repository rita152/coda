---
status: accepted
---

# Separate request retry from turn retry

`@coda/ai` may retry only request establishment, defaulting to zero retries and never replaying a stream that has begun. Retrying an entire assistant turn belongs to `@coda/agent`, where transcript state, Tool idempotency, and cancellation are visible; Pi's public `retryAssistantCall` helper is therefore outside the first AI compatibility profile.
