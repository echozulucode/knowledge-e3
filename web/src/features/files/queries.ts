/**
 * Server state for Admin → Files. The library's existing hooks (`useImages`,
 * `useUploadImage`, `useDeleteImage` in queries.ts) stay as they are for the
 * asset picker and the Overview; these add the paged list, one file's detail,
 * and an upload that reports progress.
 *
 * Every key sits under ['admin', 'images'], so the existing upload and delete
 * hooks' invalidation refreshes these too, and vice versa.
 */
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../../api.js';
import type { ImageAsset } from '../../queries.js';
import { uploadErrorMessage, type FilesListParams, type LibrarySummary } from './filesModel.js';

export const FILES_QUERY_KEY = ['admin', 'images'] as const;

export interface FilesPage {
  images: ImageAsset[];
  total: number;
  limit: number | null;
  offset: number;
  summary: LibrarySummary;
}

export interface UsedByItem {
  item_id: string;
  slug: string;
  title: string;
  status: 'draft' | 'published';
  deleted: boolean;
  topic: { slug: string; name: string; visibility: string } | null;
}

export interface FileDetail extends ImageAsset {
  created_by: string;
  created_by_username: string | null;
  /** At most 50; `used_by` is the full count. */
  used_by_items: UsedByItem[];
}

export function filesQueryString(params: Partial<FilesListParams>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  return search.toString();
}

export function useFilesPage(params: FilesListParams) {
  const qs = filesQueryString(params);
  return useQuery({
    queryKey: [...FILES_QUERY_KEY, 'page', qs],
    queryFn: () => apiClient.get<FilesPage>(`/admin/images?${qs}`),
    // The previous page stays on screen while the next loads: no flash on a filter change.
    placeholderData: keepPreviousData,
  });
}

/** One file for the sheet, so `?file=<id>` opens even when the file is not on the current page. */
export function useFileDetail(id: string | undefined) {
  return useQuery({
    queryKey: [...FILES_QUERY_KEY, 'one', id],
    queryFn: async () => (await apiClient.get<{ image: FileDetail }>(`/admin/images/${encodeURIComponent(id!)}`)).image,
    enabled: Boolean(id),
    retry: false,
  });
}

/** Every unused file (no `limit`): what "Delete unused…" works through. */
export function fetchUnusedFiles(): Promise<FilesPage> {
  return apiClient.get<FilesPage>('/admin/images?usage=unused&sort=largest');
}

export function useInvalidateFiles() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: FILES_QUERY_KEY });
}

export class UploadError extends Error {}

/**
 * POST one file to the same content-addressed endpoint `useUploadImage` uses,
 * reporting upload progress. XMLHttpRequest because fetch still exposes no
 * progress for a request body. Rejects with an UploadError carrying the
 * server's reason (type, signature, size) as display text.
 */
export function uploadFileWithProgress(
  file: File,
  onProgress: (loaded: number, total: number) => void,
): Promise<ImageAsset> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const query = file.name ? `?filename=${encodeURIComponent(file.name)}` : '';
    xhr.open('POST', `/api/v1/images${query}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded, e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as ImageAsset);
        } catch {
          reject(new UploadError('Upload finished but the reply could not be read.'));
        }
        return;
      }
      reject(new UploadError(uploadErrorMessage(xhr.status, xhr.responseText)));
    };
    xhr.onerror = () => reject(new UploadError(uploadErrorMessage(0, '')));
    xhr.send(file);
  });
}
