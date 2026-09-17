---
type: Reference
title: Run a computation on BigQuery
description: Executor run instructions — how to run a bound computation and what receipt to return.
categories: [reference]
---

# Run on BigQuery

An executor for `runtime: bigquery`. Given a computation and the agent-supplied
parameter values:

1. Bind the declared `parameters` into the query (`@year` ← the supplied value).
   Do **not** edit the computation text — only fill declared holes.
2. Submit the bound query as a BigQuery job.
3. Return a **receipt** with the fields the computation's `executor.receipt`
   declares:
   - `job_id` — the BigQuery job id (so the value can be re-read authoritatively).
   - `executed_sql` — the exact SQL the job ran (what the attester compares against).
   - `result` — the scalar result.

Receipts are runtime artifacts and are **not** stored in the bundle (spec §10.5).
