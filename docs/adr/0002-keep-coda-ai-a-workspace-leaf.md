---
status: accepted
---

# Keep Coda AI independent of workspace packages

`@coda/ai` will have no dependencies on other Coda workspace packages. Although the frozen Pi AI baseline exposes telemetry types through an internal package dependency, Coda will keep observability behind a narrow optional hook and record that coupling as an intentional compatibility deviation; credential persistence and platform storage likewise remain caller-owned.
