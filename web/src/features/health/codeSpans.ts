/**
 * Backtick-delimited code spans in System health copy (the admin UX review §2 #14).
 *
 * The server writes its check summaries and actions as plain strings and marks
 * a command the way a runbook would: `pnpm --filter … drill:restore`. Rendered
 * verbatim, the backticks are noise an admin has to trim off before pasting the
 * command. The server strings stay as they are — they are also read by logs and
 * the readiness probe — and the page splits them here instead.
 */

export type TextSegment = { kind: 'text'; value: string } | { kind: 'code'; value: string };

/**
 * Split `text` into plain and code segments. Unbalanced backticks mean the
 * string was not written as markup (or was truncated), so the whole string
 * renders as plain text rather than guessing which half is the command. An
 * empty pair (` `` `) is kept as the literal characters.
 */
export function splitCodeSpans(text: string | null | undefined): TextSegment[] {
  if (!text) return [];
  const parts = text.split('`');
  // n backticks produce n + 1 parts; an odd count of backticks is unbalanced.
  if (parts.length % 2 === 0) return [{ kind: 'text', value: text }];

  const segments: TextSegment[] = [];
  const pushText = (value: string) => {
    if (!value) return;
    const last = segments[segments.length - 1];
    if (last && last.kind === 'text') last.value += value;
    else segments.push({ kind: 'text', value });
  };
  parts.forEach((part, i) => {
    if (i % 2 === 0) pushText(part);
    else if (part.trim() === '') pushText(`\`${part}\``);
    else segments.push({ kind: 'code', value: part });
  });
  return segments;
}
