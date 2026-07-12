---
title: Invalid YAML Recovery
status: draft
malformed: : :
this is not: valid: yaml: here
---

Even with intentionally malformed YAML in the frontmatter block, the codec must
not crash. The body should still round-trip; the frontmatter object surfaces as
empty (recovery path) but the raw bytes are preserved on the no-op path.
