/**
 * ReadingPaneContext — what an item link needs to know about the reading pane.
 *
 * Provided by `ReadingPaneLayout` on the routes that host a pane (`/`,
 * `/search`) and nowhere else, so a link rendered on any other surface finds no
 * provider and navigates exactly as it always has. Item links read it in ONE
 * place (`components/itemLink.tsx`); nothing else should need to.
 */
import { createContext, useContext } from 'react';
import type { PeekSource } from './readingPaneModel.js';

export interface OpenItemOptions {
  /** The link the reader activated; focus returns to it when the pane closes. */
  origin?: HTMLElement | null;
  /** `list` (default) replaces the history entry when switching; `pane` pushes (readingPaneModel.ts). */
  source?: PeekSource;
}

export interface ReadingPaneState {
  /** The route is wide enough for a pane: a plain click on an item link opens it here. */
  enabled: boolean;
  /** The item open in the pane, or `null`. Always `null` while not `enabled`. */
  activeSlug: string | null;
  open(slug: string, options?: OpenItemOptions): void;
  close(): void;
}

export const ReadingPaneContext = createContext<ReadingPaneState | null>(null);

/** The pane on this route, or `null` where the route hosts none. */
export function useReadingPane(): ReadingPaneState | null {
  return useContext(ReadingPaneContext);
}
