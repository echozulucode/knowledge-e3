---
title: Multiline Frontmatter
status: published
description: |
  This is a literal block scalar.
  It preserves newlines as-is.
  Each line is on its own line.
  The final newline is included.

long_summary: >
  This is a folded block scalar.
  It joins lines together with spaces.
  Blank lines are preserved as paragraph breaks.

  So this becomes a new paragraph.
instructions: |
  Step 1: Read the specification carefully.
  Step 2: Understand the requirements.
  Step 3: Implement the solution.
  Step 4: Test thoroughly.
  Step 5: Review and iterate.
---

# Document with multiline YAML strings

This document contains frontmatter with literal (`|`) and folded (`>`) block scalars.

The content should preserve the exact formatting of the block scalars in the frontmatter when round-tripping.

More body text here.
