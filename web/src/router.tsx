/**
 * TanStack Router configuration for knowledge-e3.
 * Routes: /, /login, /p/:slug
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
import { PrimaryCategoryAdmin } from './pages/PrimaryCategoryAdmin.js';
import { TagGroupAdmin } from './pages/TagGroupAdmin.js';
import { TopicAdmin } from './pages/TopicAdmin.js';
import { OkfAdmin } from './pages/OkfAdmin.js';
import { SectionsAdmin } from './pages/SectionsAdmin.js';
import { ReposAdmin } from './pages/ReposAdmin.js';
import { ImagesAdmin } from './pages/ImagesAdmin.js';
import { SectionsIndex, SectionView } from './pages/Sections.js';
import { Profile } from './pages/Profile.js';
import { Help } from './pages/Help.js';

const rootRoute = new RootRoute({
  component: Root,
});

const loginRoute = new Route({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: SignIn,
});

const indexRoute = new Route({
  getParentRoute: () => rootRoute,
  path: '/',
  component: Home,
});

const browseRoute = new Route({
  getParentRoute: () => rootRoute,
  path: '/browse',
  component: PageList,
});

const pageRoute = new Route({
  getParentRoute: () => rootRoute,
  path: '/p/$slug',
  component: PageView,
});

const itemRoute = new Route({
  getParentRoute: () => rootRoute,
  path: '/items/$id',
  component: PageView,
});

const adminRoute = new Route({
  getParentRoute: () => rootRoute,
  path: '/admin',
  component: AdminHome,
});

const adminUsersRoute = new Route({
  getParentRoute: () => rootRoute,
  path: '/admin/users',
  component: AdminUsers,
});

const adminAuthRoute = new Route({
  getParentRoute: () => rootRoute,
  path: '/admin/auth',
  component: AdminAuth,
});

const profileRoute = new Route({
  getParentRoute: () => rootRoute,
  path: '/profile',
  component: Profile,
});

const primaryCategoryAdminRoute = new Route({
  getParentRoute: () => rootRoute,
  path: '/admin/primary-categories',
  component: PrimaryCategoryAdmin,
});

const tagGroupAdminRoute = new Route({
  getParentRoute: () => rootRoute,
  path: '/admin/tags-groups',
  component: TagGroupAdmin,
});

const topicAdminRoute = new Route({
  getParentRoute: () => rootRoute,
  path: '/admin/topics',
  component: TopicAdmin,
});

const okfAdminRoute = new Route({
  getParentRoute: () => rootRoute,
  path: '/admin/data',
  component: OkfAdmin,
});

const sectionsAdminRoute = new Route({
  getParentRoute: () => rootRoute,
  path: '/admin/sections',
  component: SectionsAdmin,
});

const reposAdminRoute = new Route({
  getParentRoute: () => rootRoute,
  path: '/admin/repos',
  component: ReposAdmin,
});

const imagesAdminRoute = new Route({
  getParentRoute: () => rootRoute,
  path: '/admin/images',
  component: ImagesAdmin,
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

const routeTree = rootRoute.addChildren([loginRoute, indexRoute, browseRoute, pageRoute, itemRoute, adminRoute, adminUsersRoute, adminAuthRoute, primaryCategoryAdminRoute, tagGroupAdminRoute, topicAdminRoute, okfAdminRoute, sectionsAdminRoute, reposAdminRoute, imagesAdminRoute, sectionsRoute, sectionViewRoute, profileRoute, helpRoute]);

export const router = new Router({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
