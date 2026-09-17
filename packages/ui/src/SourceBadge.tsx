/**
 * SourceBadge — that this page is kept up to date from somewhere else, and
 * nothing more (reader UX plan §6, R4.1).
 *
 * The chip used to name the registry id and the repo-relative path in its
 * tooltip ("Mirrored from topic:matlab (concepts/foo.md)"). That is the
 * instance's internal plumbing on an article, and it makes one corpus read as
 * several. A reader is told the page is maintained elsewhere and offered the
 * original; the id and the path live in Admin → Sources, where an operator can
 * act on them.
 *
 * A source that is neither a reference nor read-only renders nothing: the
 * ordinary case needs no chip.
 *
 * `url` is derived from the source's remote and is frequently null (no remote,
 * an ssh remote, an unrecognised host). That is normal, not an error — the
 * badge still renders, and simply offers no link rather than inventing one.
 */
import type { ReactNode } from 'react';
import type { ItemSourceRef } from '@echozedlabs/knowledge-types';

export interface SourceBadgeProps {
  source: ItemSourceRef | null | undefined;
  /** Renders the link to the original file; defaults to a plain anchor opening in a new tab. */
  renderOriginalLink?: (url: string) => ReactNode;
  className?: string;
}

const MAINTAINED_ELSEWHERE = 'Maintained elsewhere';

/** One sentence, no identifiers — see the module note. */
const EXTERNAL_TITLE = 'This page is maintained by another team and kept up to date automatically.';
const READ_ONLY_TITLE = 'This page is maintained elsewhere and kept up to date automatically.';

export function SourceBadge({ source, renderOriginalLink, className }: SourceBadgeProps) {
  if (!source) return null;
  const isExternal = source.role === 'reference';
  const isReadOnly = source.mode === 'read-only';
  if (!isExternal && !isReadOnly) return null;
  const original = source.url ?? null;
  return (
    <span className={className ? `kp-source ${className}` : 'kp-source'}>
      {/* `data-tone` still distinguishes the two cases for styling; the reader
          sees one claim either way. */}
      <span className="kp-badge" data-tone={isExternal ? 'external' : 'read-only'} title={isExternal ? EXTERNAL_TITLE : READ_ONLY_TITLE}>
        {MAINTAINED_ELSEWHERE}
      </span>
      {original ? (
        renderOriginalLink ? (
          renderOriginalLink(original)
        ) : (
          <a className="kp-source-suggest" href={original} target="_blank" rel="noopener noreferrer">
            View the original
          </a>
        )
      ) : null}
    </span>
  );
}
