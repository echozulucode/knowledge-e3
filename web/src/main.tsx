/**
 * Entry point: mount React app with router and QueryClient.
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { router } from './router.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { ThemeProvider } from './styles/theme.js';
import { ContentTypesProvider } from '@echozedlabs/ui';
import { useContentTypes } from './queries.js';
import { Icon, iconByKey } from './icons.js';
// Tokens MUST load before any component CSS so vars are defined when
// components first render. Order matters here.
import '@echozedlabs/ui/tokens.css';
import '@echozedlabs/ui/styles.css';
import './styles.css';
// Map the embedded markdown editor's --me-* vars to our --kp-* tokens (dark mode).
import './styles/editor-theme.css';
// Remap fixed Tailwind color utilities to --kp tokens under dark themes.
import './styles/dark-tailwind-compat.css';

// @echozedlabs/ui never talks to the API: hand it the content-type registry
// (and the icon renderer) so ContentTypeBadge can resolve `type` strings.
const renderContentTypeIcon = (key: string) => <Icon icon={iconByKey(key)} fixedWidth={false} />;

function ContentTypesBridge({ children }: { children: React.ReactNode }) {
  const { data: types = [] } = useContentTypes();
  return (
    <ContentTypesProvider types={types} renderIcon={renderContentTypeIcon}>
      {children}
    </ContentTypesProvider>
  );
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 1000 * 60 * 5, // 5 minutes
    },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <ContentTypesBridge>
            <RouterProvider router={router} />
          </ContentTypesBridge>
        </QueryClientProvider>
      </ThemeProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
