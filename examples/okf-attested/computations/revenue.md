---
type: Attested Computation
title: Revenue for fiscal year
description: Recognized revenue for a fiscal year, per Finance's definition.
categories: [reference]
tags: [finance, revenue]
status: stable
runtime: bigquery
parameters:
  - { name: year, type: integer, required: true }
executor:
  resource: /references/skills/run-on-bq.md
  receipt: [job_id, executed_sql, result]
attester:
  resource: /references/attesters/revenue.py
generated: { by: reference_agent/gemini-2.5-pro, at: 2026-08-01T00:00:00Z }
verified:
  - { by: human:ericjzim, at: 2026-08-05T00:00:00Z }
stale_after: 2027-08-01
sources:
  - id: rev-policy
    resource: https://wiki.example/finance/revenue-recognition
    title: Revenue recognition policy
    author: team:finance-fpa
    last_modified: 2026-04-02
---

# Computation

    SELECT SUM(amount) AS revenue
    FROM finance.recognized_revenue
    WHERE fiscal_year = @year

The computation binds only the declared `parameters` (`year`), per the revenue
recognition policy.[^rev-policy] The agent supplies the value for `year`; it MUST
NOT edit the SQL. The [attester](/references/attesters/revenue.py) re-derives the
same binding from the receipt's `executed_sql` and rejects any deviation.

[^rev-policy]: Revenue recognition policy
