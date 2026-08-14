# Make scheduling fair and admission local

Status: ready-for-agent

Implement the fair `WorkScheduler` Module and shorten the submission critical section as described in `../spec.md`.

Required outcomes:

- ready Work Graphs receive round-robin or equivalent bounded-fair access to process slots;
- deterministic accepted order is preserved inside each Graph;
- graph and process concurrency limits remain exact under delegation and cancellation;
- process and Graph concurrency values come from one explicit capacity policy rather than duplicated hard-coded `8` values;
- slow input-resource settlement occurs outside the global mutation fence and gates only affected delivery visibility;
- unrelated ready Graphs continue scheduling while another batch reserves or commits resources;
- acceptance remains atomic at the durable linearization point and unknown settlement is never replayed automatically;
- stress tests cover 32 Sessions, starvation, cancellation, delegation, slow resource commits, and deterministic repeatability.

Do not alter Work Graph durable schemas or Run capability assembly. Prefer a small scheduler Interface and delete old graph-order scanning logic.

## Comments

