---
okf_version: "0.2"
---

# Attested Computation — Demo Bundle

> A minimal OKF v0.2 bundle demonstrating `type: Attested Computation` (spec §10):
> a sanctioned, checkable way to compute a value. A narrative `Metric` links to a
> standalone computation; the computation names an `executor` (how to run it, and
> the receipt it must return) and a deterministic `attester` (no-LLM code that
> checks the receipt). Knowledge E3 emits and validates this contract but never
> executes it — the runtime protocol is deferred by the spec (§12).

## Metrics

* [Revenue](/metrics/revenue.md) - Recognized revenue for a fiscal year (narrates the figure).

## Computations

* [Revenue computation](/computations/revenue.md) - The sanctioned BigQuery computation behind the revenue figure.

## References

* [BigQuery runner skill](/references/skills/run-on-bq.md) - How the executor runs the computation.
