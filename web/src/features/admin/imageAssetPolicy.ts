// The delete rule for a file (used by an item or by the site → not deletable)
// lives with the rest of Files in features/files/filesModel.ts (`deleteBlockedReason`).

export function imageActionError(error: unknown, fallback: string): string {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return fallback;
}
