/**
 * AdminNav — the admin console's grouped navigation (the admin UX review §3.1),
 * rendered once by AdminLayout instead of by every page.
 *
 * One `<nav aria-label="Admin">`, three presentations chosen by the WIDTH OF THE
 * ADMIN AREA (a container query in AdminNav.css, not the viewport — the app rail
 * takes a different share of the screen at the same viewport width):
 *
 * - Desktop (≥64rem): a sticky left column. Group headings, items, and the
 *   active item's children indented beneath it. Children show only under the
 *   ACTIVE parent: all 13 destinations at once is the flat wall of links the
 *   review scored 2/5, and each parent is one click from its default child.
 * - Tablet (40–64rem): one row of top-level items that scrolls sideways and
 *   never wraps, group headings reduced to dividers, and the active parent's
 *   children as a second scrolling row.
 * - Phone (<40rem): "Admin › <page>" as a disclosure button over the full list.
 *
 * The desktop children and the tablet sub-row are two renderings of the same
 * links; CSS shows exactly one (the other is `display: none`, so it is out of
 * the accessibility tree too). Links, not tabs: `aria-current="page"` marks the
 * page, and there is no `role="tablist"` — these navigate, they do not switch
 * panels.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useSources } from '../../features/sources/queries.js';
import { useSystemHealth } from '../../features/health/queries.js';
import { VERDICT_LABELS } from '../../features/health/systemVerdict.js';
import {
  ADMIN_NAV,
  adminPageLabel,
  countOpenConflicts,
  healthNeedsAttention,
  resolveActiveAdminNav,
  type ActiveAdminNav,
  type AdminBadgeKind,
  type AdminNavItem,
  type AdminNavLink,
} from './AdminNav.model.js';
import './AdminNav.css';

interface BadgeContent {
  /** What sighted users see: a count or "!". */
  text: string;
  /** What a screen reader hears after the link name. */
  spoken: string;
}

/**
 * The two badges. Both read queries the pages already own, under the same keys,
 * so the nav adds no endpoint and joins the cache: System health is the cheap
 * instance probe (process and database checks, no library scan), and the source
 * list is a fixed-cost read (one grouped count, one `git log -1` per source)
 * whose hook already sets a staleTime, so moving between admin pages does not
 * refetch it each time. The expensive content-health report is deliberately
 * NOT a badge.
 */
function useAdminBadges(): Record<AdminBadgeKind, BadgeContent | null> {
  const sources = useSources();
  const system = useSystemHealth();
  const conflicts = countOpenConflicts(sources.data);
  const verdict = system.data?.verdict;
  return {
    sources: conflicts > 0 ? { text: String(conflicts), spoken: `${conflicts} open ${conflicts === 1 ? 'conflict' : 'conflicts'}` } : null,
    health: healthNeedsAttention(verdict) && verdict ? { text: '!', spoken: `system ${VERDICT_LABELS[verdict].toLowerCase()}` } : null,
  };
}

function Badge({ badge }: { badge: BadgeContent | null }) {
  if (!badge) return null;
  return (
    <>
      <span className="kp-admin-nav__badge" aria-hidden="true" data-testid="admin-nav-badge">
        {badge.text}
      </span>
      <span className="kp-admin-nav__sr">{`, ${badge.spoken}`}</span>
    </>
  );
}

function NavLink({
  link,
  current,
  className,
  branch = false,
  badge,
  children,
  onNavigate,
}: {
  link: AdminNavLink;
  /** Status badge. Its spoken text lives INSIDE the label span: as a sibling of a
      flex child, Chrome joined it to the name with a stray space ("Sources , 2 …"). */
  badge?: BadgeContent | null;
  current: boolean;
  /** BEM block for the link; `--current` / `--branch` modifiers are derived from it. */
  className: string;
  branch?: boolean;
  children?: ReactNode;
  onNavigate?: () => void;
}) {
  const navigate = useNavigate();
  // A plain anchor, not TanStack's <Link>: <Link> stamps aria-current="page" on
  // ANY prefix match and spreads it after our props, so on /admin/users the
  // Overview link (/admin) and on /admin/sections/pinned the Sections child
  // both claimed to be the current page. Current-ness here is decided once, by
  // the longest-prefix rule in AdminNav.model.ts. Modified clicks keep the
  // browser's behaviour (new tab, copy link); a plain click is a router navigation.
  return (
    <a
      href={link.to}
      className={[className, current ? `${className}--current` : '', branch ? `${className}--branch` : ''].filter(Boolean).join(' ')}
      aria-current={current ? 'page' : undefined}
      // The spoken badge is folded into an explicit name: a visually-hidden span is
      // absolutely positioned, which blockifies it, and Chrome then joins it to the
      // label with a stray space ("Sources , 2 open conflicts").
      aria-label={badge ? `${link.label}, ${badge.spoken}` : undefined}
      onClick={(e) => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        void navigate({ to: link.to });
        onNavigate?.();
      }}
    >
      <span className="kp-admin-nav__label">
        {link.label}
      </span>
      {badge ? (
        <span className="kp-admin-nav__badge" aria-hidden="true" data-testid="admin-nav-badge">
          {badge.text}
        </span>
      ) : null}
      {children}
    </a>
  );
}

/** Is `link` the page itself? A parent with children is never "the page" — its child is. */
function isCurrent(active: ActiveAdminNav | null, item: AdminNavItem, child?: AdminNavLink): boolean {
  if (!active || active.item.id !== item.id) return false;
  return child ? active.child?.id === child.id : !item.children;
}

/** The item is the active branch (lit, and its children shown) even when a child is the page. */
function isActiveBranch(active: ActiveAdminNav | null, item: AdminNavItem): boolean {
  return active?.item.id === item.id;
}

function ChildList({ item, active, className, onNavigate }: { item: AdminNavItem; active: ActiveAdminNav | null; className: string; onNavigate?: () => void }) {
  if (!item.children) return null;
  return (
    <ul className={className} aria-label={item.label}>
      {item.children.map((child) => (
        <li key={child.id}>
          <NavLink link={child} current={isCurrent(active, item, child)} className="kp-admin-nav__child" onNavigate={onNavigate} />
        </li>
      ))}
    </ul>
  );
}

/** The phone presentation: a disclosure over the whole list. Esc and outside clicks close it; focus returns to the button. */
function Switcher({ active, badges }: { active: ActiveAdminNav | null; badges: Record<AdminBadgeKind, BadgeContent | null> }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  // Navigating is the end of the disclosure's job, whichever link did it.
  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    };
    const onPointer = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  const anyBadge = badges.sources || badges.health;

  return (
    <div className="kp-admin-nav__switcher" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="kp-admin-nav__switcherButton"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="kp-admin-nav__crumbRoot">Admin</span>
        <span className="kp-admin-nav__crumbSep" aria-hidden="true">›</span>
        <span className="kp-admin-nav__crumbPage">{adminPageLabel(active)}</span>
        {/* Something needs attention on a page the phone cannot see: say so on the closed button. */}
        {anyBadge ? (
          <>
            <span className="kp-admin-nav__dot" aria-hidden="true" />
            <span className="kp-admin-nav__sr">, needs attention</span>
          </>
        ) : null}
        <span className="kp-admin-nav__chevron" aria-hidden="true">▾</span>
      </button>
      <div id={panelId} className="kp-admin-nav__panel" hidden={!open}>
        {ADMIN_NAV.map((group) => (
          <div key={group.id} className="kp-admin-nav__panelGroup">
            {group.heading ? <p className="kp-admin-nav__heading" id={`${panelId}-${group.id}`}>{group.heading}</p> : null}
            <ul aria-labelledby={group.heading ? `${panelId}-${group.id}` : undefined}>
              {group.items.map((item) => (
                <li key={item.id}>
                  {item.children ? (
                    <>
                      <span className="kp-admin-nav__panelParent">
                        {item.label}
                        {item.badge ? <Badge badge={badges[item.badge]} /> : null}
                      </span>
                      <ChildList item={item} active={active} className="kp-admin-nav__children" onNavigate={() => setOpen(false)} />
                    </>
                  ) : (
                    <NavLink
                      link={item}
                      current={isCurrent(active, item)}
                      className="kp-admin-nav__item"
                      badge={item.badge ? badges[item.badge] : null}
                      onNavigate={() => setOpen(false)}
                    />
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

export function AdminNav() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const active = resolveActiveAdminNav(pathname);
  const badges = useAdminBadges();
  const headingPrefix = useId();

  return (
    <nav className="kp-admin-nav" aria-label="Admin">
      <Switcher active={active} badges={badges} />

      <ul className="kp-admin-nav__groups">
        {ADMIN_NAV.map((group) => (
          <li key={group.id} className="kp-admin-nav__group" data-group={group.id}>
            {group.heading ? (
              <span className="kp-admin-nav__heading" id={`${headingPrefix}-${group.id}`}>
                {group.heading}
              </span>
            ) : null}
            <ul className="kp-admin-nav__items" aria-labelledby={group.heading ? `${headingPrefix}-${group.id}` : undefined}>
              {group.items.map((item) => (
                <li key={item.id}>
                  <NavLink
                    link={item}
                    current={isCurrent(active, item)}
                    className="kp-admin-nav__item"
                    branch={isActiveBranch(active, item) && Boolean(item.children)}
                    badge={item.badge ? badges[item.badge] : null}
                  />
                  {isActiveBranch(active, item) ? <ChildList item={item} active={active} className="kp-admin-nav__children" /> : null}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>

      {/* Tablet only: the active parent's children as their own scrolling row. */}
      {active?.item.children ? (
        <ChildList item={active.item} active={active} className="kp-admin-nav__subrow" />
      ) : null}
    </nav>
  );
}
