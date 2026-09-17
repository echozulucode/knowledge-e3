"""Read-only views over the project's trackers, for the `just` recipes.

This exists as a file rather than as a one-liner inside the justfile because the
justfile has to run under both `sh` (Linux, macOS, CI) and PowerShell (Windows),
and the two disagree about quoting badly enough that any embedded script would
work in one and silently break in the other. A file has no quoting to survive.

Usage:
    python scripts/tracker.py issues
    python scripts/tracker.py quarantine
"""

from __future__ import annotations

import sys
from pathlib import Path

try:
    import yaml
except ImportError:  # pragma: no cover - dependency-free fallback
    sys.exit("tracker: PyYAML is not installed (`pip install pyyaml`)")

ROOT = Path(__file__).resolve().parent.parent


def _ascii(text: str, width: int) -> str:
    """Windows consoles are not UTF-8 by default and this repo's prose is full of
    en-dashes; a tracker view that crashes on its own punctuation is useless."""
    return text[:width].encode("ascii", "replace").decode("ascii")


def issues() -> int:
    data = yaml.safe_load((ROOT / "docs" / "issues.yaml").read_text(encoding="utf-8"))
    items = data["issues"] if isinstance(data, dict) else data
    rows = sorted(
        (i for i in items if str(i.get("status")) == "open"),
        key=lambda r: int(r["id"]),
        reverse=True,
    )
    for i in rows:
        print("#{:<4} [{:<3}] {}".format(i["id"], str(i.get("priority", "-")), _ascii(str(i.get("title", "")), 92)))
    print("\n{} open of {}".format(len(rows), len(items)))
    return 0


def quarantine() -> int:
    """The register's headings — what is still excluded from the e2e gate, and why."""
    path = ROOT / "docs" / "e2e-quarantine.md"
    if not path.exists():
        print("no quarantine register at {}".format(path))
        return 0
    shown = 0
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("### ") or line.startswith("## "):
            print(_ascii(line, 110))
            shown += 1
    if shown == 0:
        print("register has no sections")
    return 0


COMMANDS = {"issues": issues, "quarantine": quarantine}

if __name__ == "__main__":
    name = sys.argv[1] if len(sys.argv) > 1 else ""
    if name not in COMMANDS:
        sys.exit("tracker: expected one of {}".format(", ".join(sorted(COMMANDS))))
    raise SystemExit(COMMANDS[name]())
