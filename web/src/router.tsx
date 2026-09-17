/**
 * TanStack Router configuration for knowledge-e3.
 * Routes: /, /login, /p/:slug, /topics, /topics/:slug, /latest, /search, /series/:slug, /new, /p/:slug/edit, /review,
 * and every /admin* page as a child of one AdminLayout route (the grouped admin nav).
 */

import { RootRoute, Route, Router } from '@tanstack/react-router';
import { Root } from './pages/Root.js';
import { SignIn } from './pages/SignIn.js';
import { Home } from './pages/Home.js';
import { PageList } from './pages/PageList.js';
import { PageView } from './pages/PageView.js';
import { AdminHome } from './pages/AdminHome.js';
import { AdminUsers } from './pages/AdminUsers.js';
import { AdminAuth } from './pages/AdminAuth.js';
import { AdminTokens } from './pages/AdminTokens.js';
import { AdminAudit } from './pages/AdminAudit.js';
import { PrimaryCategoryAdmin } from './pages/PrimaryCategoryAdmin.js';
import { TagGroupAdmin } from './pages/TagGroupAdmin.js';
import { TopicAdmin } from './pages/TopicAdmin.js';
import { TopicEditPage } from './pages/TopicEditPage.js';
import { OkfAdmin } from './pages/OkfAdmin.js';
import { SectionsAdmin } from './pages/SectionsAdmin.js';
import { SectionEditPage } from './pages/SectionEditPage.js';
import { PinnedTopicsAdmin } from './pages/PinnedTopicsAdmin.js';
import { AdminLayout } from './components/admin/AdminLayout.js';
import { ReposAdmin } from './pages/ReposAdmin.js';
import { ImagesAdmin } from './pages/ImagesAdmin.js';
import { SectionsIndex, SectionView } from './pages/Sections.js';
import { Profile } from './pages/Profile.js';
import { Help } from './pages/Help.js';
import { TopicsIndex } from './features/topic/TopicsIndex.js';
import { TopicLanding } from './features/topic/TopicLanding.js';
import { LatestFeed } from './features/feed/LatestFeed.js';
import { SeriesPage } from './features/feed/SeriesPage.js';
import { Compose } from './features/compose/Compose.js';
import { ContentHealth } from './features/health/ContentHealth.js';
import { SystemHealth } from './features/health/SystemHealth.js';
import { ReviewQueue } from './features/review/ReviewQueue.js';
import { SearchPage } from './features/search/SearchPage.js';
import { validatePeekSearch } from './features/reading-pane/readingPaneModel.js';

const rootRoute = new RootRoute({
  component: Root,
});

const loginRoute = new Route({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: SignIn,
});

// `?peek=<slug>` is the item open in the reading pane (features/reading-pane),
// on the routes that host one. Only `peek` is validated: the router merges a
// route's validated search over the raw params, so every other key a page
// reads from the URL (Search's `q`, `tag`, …) passes through untouched.
const indexRoute = new Route({
  getParentRoute: () => rootRoute,
  path: '/',
  component: Home,
  validateSearch: validatePeekSearch,
});

const browseRoute = new Route({
  getParentRoute: () => rootRoute,
  path: '/browse',
  component: PageList,
});

// `/p/$slug` is the CANONICAL, shareable item URL — all internal navigation
// links here.
const pageRoute = new Route({
  getParentRoute: () => rootRoute,
  path: '/p/$slug',
  component: PageView,
});

// `/items/$id` is retained as a stable-id deep link: the id is immutable while a
// slug changes on rename, so id-based references (and any legacy/external links)
// keep resolving. Not used for internal navigation anymore.
const itemRoute = new Route({
  getParentRoute: () => rootRoute,
  path: '/items/$id',
  component: PageView,
});

const profileRoute = new Route({
  getParentRoute: () => rootRoute,
  path: '/profile',
  component: Profile,
});

const sectionsRoute = new Route({
  getParentRoute: () => rootRoute,
  path: '/sections',
  component: SectionsIndex,
});

const sectionViewRoute = new Route({
  getParentRoute: () => rootRoute,
  path: '/sections/$slug',
  component: SectionView,
});

const helpRoute = new Route({
  getParentRoute: () => rootRoute,
  path: '/help',
  component: Help,
});

// Phase 2 routes (the knowledge hub plan Appendix C).
const topicsRoute = new Route({ getParentRoute: () => rootRoute, path: '/topics', component: TopicsIndex });
const topicLandingRoute = new Route({ getParentRoute: () => rootRoute, path: '/topics/$slug', component: TopicLanding });
const latestRoute = new Route({ getParentRoute: () => rootRoute, path: '/latest', component: LatestFeed });
const seriesRoute = new Route({ getParentRoute: () => rootRoute, path: '/series/$slug', component: SeriesPage });
const composeNewRoute = new Route({ getParentRoute: () => rootRoute, path: '/new', component: Compose });
const composeEditRoute = new Route({ getParentRoute: () => rootRoute, path: '/p/$slug/edit', component: Compose });
// §3.5 item 1: the palette's grouped results as a linkable, full-page surface.
// `peek` as on `/` above: the reading pane beside the results.
const searchRoute = new Route({ getParentRoute: () => rootRoute, path: '/search', component: SearchPage, validateSearch: validatePeekSearch });
// Phase 4 (§8.2): the review queue, grouped by source.
const reviewRoute = new Route({ getParentRoute: () => rootRoute, path: '/review', component: ReviewQueue });

// ---------------------------------------------------------------- /admin
// One layout route owns every admin URL (the admin UX review §3.1):
// AdminLayout renders the grouped nav once and the page in its <Outlet />.
// Child paths are relative to '/admin', so every URL is exactly what it was
// when these were separate root routes.
const adminLayoutRoute = new Route({ getParentRoute: () => rootRoute, path: '/admin', component: AdminLayout });
// '/' under the layout is '/admin' itself: the Overview.
const adminIndexRoute = new Route({ getParentRoute: () => adminLayoutRoute, path: '/', component: AdminHome });
const adminUsersRoute = new Route({ getParentRoute: () => adminLayoutRoute, path: 'users', component: AdminUsers });
const adminAuthRoute = new Route({ getParentRoute: () => adminLayoutRoute, path: 'auth', component: AdminAuth });
// Review §4.7: API tokens moved out of the settings page onto their own list.
// 'auth' has no children, so it still matches only /admin/auth.
const adminTokensRoute = new Route({ getParentRoute: () => adminLayoutRoute, path: 'auth/tokens', component: AdminTokens });
// Plan §6 D1: the audit read surface. Filters live in the query string so a
// finding is a shareable link.
const adminAuditRoute = new Route({ getParentRoute: () => adminLayoutRoute, path: 'audit', component: AdminAudit });
const topicAdminRoute = new Route({ getParentRoute: () => adminLayoutRoute, path: 'topics', component: TopicAdmin });
// Review §4.5: a topic's editor is its own linkable page. 'topics' has no
// children, so it still matches only /admin/topics; the nav lights Topics for
// this path by longest prefix (AdminNav.model.ts).
const topicEditRoute = new Route({ getParentRoute: () => adminLayoutRoute, path: 'topics/$slug', component: TopicEditPage });
const primaryCategoryAdminRoute = new Route({ getParentRoute: () => adminLayoutRoute, path: 'primary-categories', component: PrimaryCategoryAdmin });
const tagGroupAdminRoute = new Route({ getParentRoute: () => adminLayoutRoute, path: 'tags-groups', component: TagGroupAdmin });
const okfAdminRoute = new Route({ getParentRoute: () => adminLayoutRoute, path: 'data', component: OkfAdmin });
const sectionsAdminRoute = new Route({ getParentRoute: () => adminLayoutRoute, path: 'sections', component: SectionsAdmin });
// Review §4.1/§4.2: the section editor is its own linkable page and Pinned
// topics its own sub-page. 'sections/new' and 'sections/pinned' are literal
// segments, which the router ranks above the dynamic '$slug' at the same depth
// regardless of declaration order, so a section slug can never shadow them.
const sectionNewRoute = new Route({ getParentRoute: () => adminLayoutRoute, path: 'sections/new', component: SectionEditPage });
const pinnedTopicsAdminRoute = new Route({ getParentRoute: () => adminLayoutRoute, path: 'sections/pinned', component: PinnedTopicsAdmin });
const sectionEditRoute = new Route({ getParentRoute: () => adminLayoutRoute, path: 'sections/$slug', component: SectionEditPage });
const reposAdminRoute = new Route({ getParentRoute: () => adminLayoutRoute, path: 'repos', component: ReposAdmin });
const imagesAdminRoute = new Route({ getParentRoute: () => adminLayoutRoute, path: 'images', component: ImagesAdmin });
const contentHealthRoute = new Route({ getParentRoute: () => adminLayoutRoute, path: 'health', component: ContentHealth });
// Admin -> Health -> System (plan §5): the sibling page, not a merge. A route
// without children matches only its full path, so /admin/health keeps its own
// component and /admin/health/system gets this one.
const systemHealthRoute = new Route({ getParentRoute: () => adminLayoutRoute, path: 'health/system', component: SystemHealth });

const adminRouteTree = adminLayoutRoute.addChildren([
  adminIndexRoute,
  adminUsersRoute,
  adminAuthRoute,
  adminTokensRoute,
  adminAuditRoute,
  topicAdminRoute,
  topicEditRoute,
  primaryCategoryAdminRoute,
  tagGroupAdminRoute,
  okfAdminRoute,
  sectionsAdminRoute,
  sectionNewRoute,
  pinnedTopicsAdminRoute,
  sectionEditRoute,
  reposAdminRoute,
  imagesAdminRoute,
  contentHealthRoute,
  systemHealthRoute,
]);

const routeTree = rootRoute.addChildren([searchRoute, reviewRoute, topicsRoute, topicLandingRoute, latestRoute, seriesRoute, composeNewRoute, composeEditRoute, loginRoute, indexRoute, browseRoute, pageRoute, itemRoute, adminRouteTree, sectionsRoute, sectionViewRoute, profileRoute, helpRoute]);

export const router = new Router({
  routeTree,
  // Restore scroll position on Back. Without this, clicking a result deep in a
  // list and pressing Back returns you to the top of the list.
  scrollRestoration: true,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
