---
title: Definition Lists and References
status: published
---

# Definition Lists and Footnote References

This document tests definition-list syntax (a GFM extension) and footnote-style references.

## Technology Definitions

Apple
:   A fruit that is round or elongated, and often red, green, or yellow in colour, growing at the end of the stem of a tree.

Database
:   An organized collection of structured data or information, typically stored electronically in a computer system and usually accessed or manipulated through a database management system.

API
:   An application programming interface is a set of rules and protocols for building and integrating application software.

Markdown
:   A lightweight markup language with plain-text-formatting syntax, designed so that it can be converted to HTML and other formats using a tool of the same name.

## Footnote References

Here is some text with a footnote[^1]. And here is another one[^2].

Another paragraph with a longer note reference[^3].

## Footnote Definitions

[^1]: This is the first footnote containing a simple definition.

[^2]: This is the second footnote. It can contain multiple paragraphs.

    With more details here.

[^3]: This footnote contains code:
    ```python
    def hello():
        print("world")
    ```

    And markdown formatting like **bold** and *italic*.

## Inline Code and References

A code reference: `const x = 5;`[^fn-code]

And another: `SELECT * FROM users;`[^fn-sql]

[^fn-code]: JavaScript example

[^fn-sql]: SQL example query

## Complex Content

Definition with code:

Algorithm
:   A step-by-step procedure for performing a computation or solving a problem. Example:
    ```
    1. Start
    2. Input: array of numbers
    3. Sort array
    4. Output: sorted array
    5. End
    ```

End of definitions and footnotes document.
