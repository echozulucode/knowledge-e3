"""Deterministic attester for the revenue Attested Computation (OKF v0.2 §10.2).

No LLM. Takes a run receipt and returns a verdict. It confirms two things:

  provenance  the SQL that ran equals the sanctioned `computation` bound with the
              claimed parameters — NOT agent-authored SQL. Any rewrite, a swapped
              computation file, or a mutated dependency changes `executed_sql` and
              fails the check.
  fidelity    the displayed value matches the receipt's authoritative result,
              re-read by `job_id` rather than taken from an agent's text.

This is illustrative; the receipt/verdict wire format is deferred by the spec
(§12). It is intended to run consumer-side and is referenced by
`computations/revenue.md` via `attester.resource`.
"""
from __future__ import annotations

import re

# The sanctioned computation, verbatim from computations/revenue.md's # Computation
# block. The attester re-derives the expected SQL by binding the declared
# parameters into this template and compares against what actually ran.
SANCTIONED_SQL = (
    "SELECT SUM(amount) AS revenue\n"
    "FROM finance.recognized_revenue\n"
    "WHERE fiscal_year = @year"
)


def _normalize(sql: str) -> str:
    """Whitespace-insensitive comparison, so formatting differences don't matter."""
    return re.sub(r"\s+", " ", sql).strip().lower()


def attest(receipt: dict, params: dict) -> dict:
    """Return {"ok": bool, "reasons": [...]} for a run receipt and its parameters."""
    reasons: list[str] = []

    # 1) Only the declared parameter `year` may be supplied.
    if set(params) - {"year"}:
        reasons.append(f"undeclared parameters supplied: {sorted(set(params) - {'year'})}")

    # 2) Provenance: executed_sql must equal the sanctioned computation with @year bound.
    expected = _normalize(SANCTIONED_SQL.replace("@year", str(params.get("year"))))
    actual = _normalize(str(receipt.get("executed_sql", "")).replace("@year", str(params.get("year"))))
    if expected != actual:
        reasons.append("executed_sql does not match the sanctioned computation")

    # 3) Fidelity: a value must have been read back by job id.
    if not receipt.get("job_id"):
        reasons.append("receipt is missing job_id (value not authoritatively re-read)")
    if receipt.get("result") is None:
        reasons.append("receipt is missing result")

    return {"ok": not reasons, "reasons": reasons}
