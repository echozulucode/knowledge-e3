/**
 * SectionBlock — the one renderer for a curated Section's items, shared by the
 * topic landing page and the site Home. Lifted out of TopicLanding so Home does
 * not grow a second copy: the two Markdown renderers showed what happens when a
 * surface forks its own, and a Section's badge row and preview rule are exactly
 * the kind of detail that drifts.
 *
 * Where the surfaces genuinely differ — heading level, the wrapper's class — the
 * difference is a prop, not a fork.
 */
import type { ItemSummary, SectionView } from '@echozedlabs/knowledge-types';
import { ContentTypeBadge, FreshnessBadge, ItemRow as SharedItemRow, TrustBadge, itemPreview } from '@echozedlabs/ui';
import { itemHref, itemSlugLink } from '../../components/itemLink.js';
import { openReviewOf, reviewDisplayState } from '../review/reviewModel.js';
import './TopicLanding.css';

/**
 * One item in a Section block, as the shared `ItemRow` (plan R1.3). The badge
 * set and the preview rule are the same ones the feed and Sections use.
 */
function ItemRow({ item }: { item: ItemSummary }) {
  // `in-review` (plan §8.2) wins over the lifecycle state, as on the read page.
  const openReview = openReviewOf(item);
  return (
    <SharedItemRow
      className="TopicLanding__item"
      title={item.title}
      href={itemHref(item.slug)}
      renderLink={itemSlugLink(item.slug)}
      preview={itemPreview(item)}
      badges={
        <>
          {item.type ? <ContentTypeBadge type={item.type} size="sm" /> : null}
          <FreshnessBadge
            displayState={reviewDisplayState(item.display_state, openReview)}
            staleAfter={item.stale_after}
            supersededBy={item.superseded_by}
            reviewUrl={openReview?.url}
          />
          {/* `mark`: an index surface names no tier for an unverified item and a
              quiet check for a verified one (home plan R2.4). */}
          {item.trust_tier ? <TrustBadge tier={item.trust_tier} generatedBy={item.generated_by} variant="mark" className="TopicLanding__trust" /> : null}
        </>
      }
    />
  );
}

export function SectionBlock({
  section,
  heading,
  id,
  className,
}: {
  section: SectionView;
  heading: string;
  id: string;
  /** Extra class on the wrapper, so Home can place the block in its own grid. */
  className?: string;
}) {
  return (
    <section
      className={`TopicLanding__section${className ? ` ${className}` : ''}`}
      aria-labelledby={id}
      data-slot={section.slot ?? 'none'}
      id={`section-${section.slug}`}
    >
      <h2 id={id}>{heading}</h2>
      {section.description ? <p className="TopicLanding__sectionLead">{section.description}</p> : null}
      <ul className="TopicLanding__items">
        {(section.items ?? []).map((item) => <ItemRow key={item.id} item={item} />)}
      </ul>
    </section>
  );
}
