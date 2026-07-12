import type { EditorDiagnostic, HostServices, LinkSuggestion } from '@echozedlabs/react';

export interface ItemLinkSearchResult {
  id: string;
  title: string;
  slug?: string;
  updated_at?: string;
  status?: 'draft' | 'published';
  snippet?: string;
}

export interface CreateItemHostServicesOptions {
  searchItems?: (query: string, signal?: AbortSignal) => Promise<LinkSuggestion[]>;
  resolveItemLink?: (target: string) => string | Promise<string | undefined> | undefined;
  navigateToItem?: (href: string) => void;
  reportDiagnostics?: (diagnostics: EditorDiagnostic[]) => void;
  /** Upload a pasted/dropped/inserted image; returns the bundle-relative URL. */
  uploadAsset?: (file: File, signal?: AbortSignal) => Promise<{ url: string; alt?: string }>;
}

export function createItemEditorHostServices(
  options: CreateItemHostServicesOptions = {},
): HostServices {
  return {
    searchLinks: options.searchItems,
    resolveWikiLink: options.resolveItemLink,
    navigateLink: options.navigateToItem,
    reportDiagnostics: options.reportDiagnostics,
    uploadAsset: options.uploadAsset,
  };
}

/**
 * Upload an image file to Knowledge E3 and return its bundle-relative URL
 * (`/assets/<file>`). Wired into the editor's `uploadAsset` host service so
 * paste / drag-drop / insert-image just work.
 */
export async function uploadImageAsset(
  file: File,
  signal?: AbortSignal,
): Promise<{ url: string; alt?: string }> {
  const query = file.name ? `?alt=${encodeURIComponent(file.name)}` : '';
  const res = await fetch(`/api/v1/images${query}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
    signal,
  });
  if (!res.ok) throw new Error(`Image upload failed (${res.status}).`);
  const data = (await res.json()) as { url: string; alt?: string | null };
  return { url: data.url, alt: data.alt ?? undefined };
}

export function itemToLinkSuggestion(item: ItemLinkSearchResult): LinkSuggestion {
  return {
    id: item.id,
    label: item.title,
    insertText: `[${escapeMarkdownLabel(item.title)}](<${escapeMarkdownDestination(item.id)}>)`,
    description: item.snippet ?? item.slug ?? item.status,
  };
}

export async function searchItemLinkSuggestions(
  query: string,
  fetchResults: (query: string, signal?: AbortSignal) => Promise<ItemLinkSearchResult[]>,
  options: { currentItemId?: string; limit?: number; signal?: AbortSignal } = {},
): Promise<LinkSuggestion[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const limit = options.limit ?? 8;
  const results = await fetchResults(trimmed, options.signal);
  return results
    .filter((item) => item.id !== options.currentItemId)
    .slice(0, limit)
    .map(itemToLinkSuggestion);
}

function escapeMarkdownLabel(value: string): string {
  return value.replace(/([\\\[\]])/g, '\\$1');
}

function escapeMarkdownDestination(value: string): string {
  return value.replace(/[<>]/g, encodeURIComponent);
}
