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
import { ContentTypeBadge, resolveContentTypeMeta } from '../components/ContentTypeBadge.js';
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
                <p>{previewOf(item)}</p>
                <Link to="/p/$slug" params={{ slug: item.slug }} className="Sections__readMore">
                  Read full answer <Icon icon={appIcons.arrowRight} fixedWidth={false} />
                </Link>
              </div>
            </details>
          ))}
        </div>
      ) : layout === 'cards' ? (
        <div className="Sections__cardsGrid">
          {items.map((item) => {
            const cover = coverImageOf(item);
            const authors = authorsOf(item);
            const date = formatDate(displayDateOf(item));
            return (
              <Link key={item.id} to="/p/$slug" params={{ slug: item.slug }} className="Sections__article">
                {cover ? (
                  <span className="Sections__articleCover" aria-hidden="true">
                    <img src={cover} alt="" loading="lazy" />
                  </span>
                ) : null}
                <div className="Sections__articleMeta">
                  {item.type ? <ContentTypeBadge type={item.type} size="sm" /> : null}
                  {date ? <span className="Sections__articleDate">{date}</span> : null}
                </div>
                <h2 className="Sections__articleTitle">{item.title}</h2>
                <p className="Sections__articleExcerpt">{previewOf(item)}</p>
                <div className="Sections__articleByline">
                  {authors.length ? <span>{authors.join(', ')}</span> : null}
                  <span>{readingTimeMinutes(item.body_markdown)} min read</span>
                </div>
              </Link>
            );
          })}
        </div>
      ) : (
        <ul className="Sections__list">
          {items.map((item) => (
            <li key={item.id}>
              <Link to="/p/$slug" params={{ slug: item.slug }} className="Sections__listItem">
                <span className="Sections__listMain">
                  <span className="Sections__listTitle">{item.title}</span>
                  <span className="Sections__listPreview">{previewOf(item)}</span>
                </span>
                <span className="Sections__listSide">
                  {item.type ? <ContentTypeBadge type={item.type} size="sm" /> : null}
                  <Icon icon={appIcons.chevronRight} fixedWidth={false} />
                </span>
              </Link>
            </li>
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

function previewOf(page: Page): string {
  const fm = page.frontmatter as Record<string, unknown> | undefined;
  const summary = fm && typeof fm['summary'] === 'string' ? (fm['summary'] as string).trim() : '';
  if (summary) return summary;
  const body = (page.body_markdown || '')
    .replace(/^#+\s+.*$/gm, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/[#*_`>[\]()!-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return body.slice(0, 200) || 'No preview available.';
}

function filterLabel(s: Section): string {
  const parts: string[] = [];
  if (s.type) parts.push(`type: ${s.type}`);
  if (s.space) parts.push(`topic: ${s.space}`);
  return parts.length ? parts.join(' · ') : 'all items';
}
