/**
 * Sections — purpose-specific landing views (blogs, FAQs, best practices…),
 * curated in Admin → Sections. Each section is a filter over a concept `type`
 * and/or topic, kept fully OKF-aligned.
 *
 * The section VIEW is type-aware: an FAQ section renders as an accordion, a
 * publishing section (blog/series/release notes) as an article-card grid, and
 * everything else as a clean list — each carrying content-type badges.
 */
import { Link, useParams } from '@tanstack/react-router';
import { useSections, usePages, useContentTypes, type Section, type Page } from '../queries.js';
import { ContentTypeBadge, ItemCard, ItemRow, itemPreview, resolveContentTypeMeta } from '@echozedlabs/ui';
import { itemHref, itemSlugLink } from '../components/itemLink.js';
import { authorsOf, coverImageOf, displayDateOf, formatDate, readingTimeMinutes } from '../features/blog/blogMeta.js';
import { Icon, appIcons, iconByKey } from '../icons.js';
import './Sections.css';

export function SectionsIndex() {
  const { data: sections = [], isLoading } = useSections();
  const { data: contentTypes = [] } = useContentTypes();

  return (
    <main className="Sections" aria-labelledby="sections-title">
      <header className="Sections__hero">
        <p className="Sections__eyebrow"><Icon icon={appIcons.layerGroup} fixedWidth={false} /> Sections</p>
        <h1 id="sections-title">Browse knowledge by purpose</h1>
        <p className="Sections__lede">Curated views over content types and topics — blogs, FAQs, runbooks, and more.</p>
      </header>

      {isLoading ? (
        <p className="Sections__muted">Loading…</p>
      ) : sections.length === 0 ? (
        <div className="Sections__empty">
          <p>No sections defined yet.</p>
          <Link to="/admin/sections" className="Sections__emptyCta">Create sections in Admin →</Link>
        </div>
      ) : (
        <div className="Sections__grid">
          {sections.map((s) => {
            const meta = resolveContentTypeMeta(s.type, contentTypes);
            return (
              <Link key={s.slug} to="/sections/$slug" params={{ slug: s.slug }} className="Sections__card" data-group={meta?.groupKey ?? 'default'}>
                <span className="Sections__cardIcon"><Icon icon={iconByKey(meta?.icon)} fixedWidth={false} /></span>
                <span className="Sections__cardName">{s.name}</span>
                {s.description ? <span className="Sections__cardDesc">{s.description}</span> : null}
                <span className="Sections__cardFilter">{filterLabel(s)}</span>
              </Link>
            );
          })}
        </div>
      )}
    </main>
  );
}

export function SectionView() {
  const params = useParams({ strict: false }) as { slug?: string };
  const { data: sections = [] } = useSections();
  const { data: contentTypes = [] } = useContentTypes();
  const section = sections.find((s) => s.slug === params.slug);
  const meta = resolveContentTypeMeta(section?.type, contentTypes);
  const layout = layoutFor(meta?.groupKey, meta?.label);

  const { data: items = [], isLoading } = usePages({
    type: section?.type,
    space: section?.space,
    tags: section?.tags,
    status: 'published',
    limit: 200,
    // A blog-style card grid reads as a chronological feed; order by publish date.
    sort: layout === 'cards' ? 'published' : undefined,
  });

  if (!section) {
    return (
      <main className="Sections">
        <p className="Sections__muted">Section not found.</p>
        <Link to="/sections" className="Sections__back">← All sections</Link>
      </main>
    );
  }

  return (
    <main className="Sections" aria-labelledby="section-view-title">
      <header className="Sections__hero">
        <Link to="/sections" className="Sections__back">← All sections</Link>
        <div className="Sections__heroHead">
          <h1 id="section-view-title">{section.name}</h1>
          {section.type ? <ContentTypeBadge type={section.type} /> : null}
        </div>
        {section.description ? <p className="Sections__lede">{section.description}</p> : null}
        <p className="Sections__muted">{items.length} published · {filterLabel(section)}</p>
      </header>

      {isLoading ? (
        <p className="Sections__muted">Loading…</p>
      ) : items.length === 0 ? (
        <p className="Sections__muted">No published items in this section yet.</p>
      ) : layout === 'faq' ? (
        <div className="Sections__faqList">
          {items.map((item) => (
            <details key={item.id} className="Sections__faq">
              <summary className="Sections__faqQ">
                <span>{item.title}</span>
                <Icon icon={appIcons.chevronRight} fixedWidth={false} />
              </summary>
              <div className="Sections__faqA">
                {previewOf(item) ? <p>{previewOf(item)}</p> : null}
                <Link to="/p/$slug" params={{ slug: item.slug }} className="Sections__readMore">
                  Read full answer <Icon icon={appIcons.arrowRight} fixedWidth={false} />
                </Link>
              </div>
            </details>
          ))}
        </div>
      ) : layout === 'cards' ? (
        <div className="Sections__cardsGrid">
          {/* The publishing layout is the feed's card, not a second one
              (plan R1.3): same badge row, same preview rule, same byline. */}
          {items.map((item) => {
            const authors = authorsOf(item);
            const date = formatDate(displayDateOf(item));
            return (
              <ItemCard
                key={item.id}
                className="Sections__article"
                layout="stacked"
                titleAs="h2"
                title={item.title}
                href={itemHref(item.slug)}
                renderLink={itemSlugLink(item.slug)}
                cover={coverImageOf(item)}
                preview={previewOf(item)}
                badges={item.type ? <ContentTypeBadge type={item.type} size="sm" /> : null}
                meta={[
                  authors.length ? authors.join(', ') : null,
                  date || null,
                  `${readingTimeMinutes(item.body_markdown)} min read`,
                ]}
              />
            );
          })}
        </div>
      ) : (
        <ul className="Sections__list">
          {/* The list layout is the topic landing's row (plan R1.3). The whole
              row stays clickable — the shared row stretches its title link over
              itself, which is what the wrapping <Link> here used to do. */}
          {items.map((item) => (
            <ItemRow
              key={item.id}
              title={item.title}
              href={itemHref(item.slug)}
              renderLink={itemSlugLink(item.slug)}
              preview={previewOf(item)}
              badges={item.type ? <ContentTypeBadge type={item.type} size="sm" /> : null}
              trailing={<Icon icon={appIcons.chevronRight} fixedWidth={false} />}
            />
          ))}
        </ul>
      )}
    </main>
  );
}

type SectionLayout = 'faq' | 'cards' | 'list';

function layoutFor(groupKey: string | undefined, label: string | undefined): SectionLayout {
  if (label === 'FAQ') return 'faq';
  if (groupKey === 'publishing') return 'cards';
  return 'list';
}

/**
 * The item's preview, through the one shared rule (plan R1.4). The local
 * `summary`-then-`description`-then-scraped-body version this replaces was one
 * of four such rules, and the only one that ever printed "No preview
 * available." — a card now simply shows no preview line when there is nothing
 * to say, the same way a healthy item shows no freshness badge.
 */
function previewOf(page: Page): string | null {
  const fm = page.frontmatter as Record<string, unknown> | undefined;
  const str = (key: string) => (fm && typeof fm[key] === 'string' ? (fm[key] as string) : null);
  return itemPreview({ description: str('description'), summary: str('summary'), body: page.body_markdown });
}

function filterLabel(s: Section): string {
  const parts: string[] = [];
  if (s.type) parts.push(`type: ${s.type}`);
  if (s.space) parts.push(`topic: ${s.space}`);
  // Any-of, so the separator between tags is "or" while the filters AND.
  if (s.tags?.length) parts.push(`tags: ${s.tags.join(' or ')}`);
  return parts.length ? parts.join(' · ') : 'all items';
}
