---
title: Mixed Line Endings
status: published
---

Some content with LF line endings as above.
This line also uses LF.

Now this section has CRLF line endings instead.
This line also has CRLF ending.
And another line with CRLF.

Back to LF in this section.
This uses just LF.

A bulleted list with mixed endings:

- Item one with LF
- Item two with CRLF
- Item three with LF
  - Nested with CRLF
  - Nested with LF

Code block to test preservation:

```javascript
// This code block also has mixed line endings.
function test() {
  return "mixed line endings preserved";
}
```

Final paragraph with LF ending.
