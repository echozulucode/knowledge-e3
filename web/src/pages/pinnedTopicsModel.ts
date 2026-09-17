/**
 * Pinned topics editor rules (the admin UX review §2 #8).
 *
 * Both rules already exist on the server, which enforces them by silently
 * dropping what breaks them (`ConfigService.setPinnedTopics` slices to the cap;
 * `normalizePin` drops a dark cover with no cover). An admin who saved seven
 * pins, or a dark cover alone, was told "Saved" and lost data. The editor
 * states the same rules up front instead.
 */

/**
 * Mirrors `MAX_PINNED_TOPICS` in server/src/config/config.service.ts — keep the
 * two equal. The web app cannot import server code, and the constant is not in
 * a shared package.
 */
export const MAX_PINNED_TOPICS = 6;

export interface PinCoverFields {
  cover?: string;
  cover_dark?: string;
}

export const DARK_COVER_NEEDS_COVER = 'Set a cover before a dark theme cover.';

/** Row index → the message for that row's dark cover. Empty when every row can be saved as typed. */
export function pinRowProblems(rows: readonly PinCoverFields[]): Record<number, string> {
  const problems: Record<number, string> = {};
  rows.forEach((row, i) => {
    // The resolver falls `cover_dark` back to `cover`, never the other way, so
    // a dark cover alone is not a pair the server keeps.
    if (row.cover_dark?.trim() && !row.cover?.trim()) problems[i] = DARK_COVER_NEEDS_COVER;
  });
  return problems;
}

export function canAddPin(count: number): boolean {
  return count < MAX_PINNED_TOPICS;
}

export function pinCountLabel(count: number): string {
  return `${count} of ${MAX_PINNED_TOPICS}`;
}

// ---- Pinned topics page (review §4.2): one pin at a time over the whole list ----

/** A pin as the editor holds it; structurally `PinnedTopicInput` in queries.ts. */
export interface PinDef extends PinCoverFields {
  topic: string;
  color?: string;
  icon?: string;
}

export interface PinTopicRef {
  id: string;
  slug: string;
  name: string;
  visibility?: 'public' | 'private';
}

/** A pin names its topic by slug or id; the server resolves either. */
export function pinMatchesTopic(pin: Pick<PinDef, 'topic'>, topic: Pick<PinTopicRef, 'id' | 'slug'>): boolean {
  return pin.topic === topic.slug || pin.topic === topic.id;
}

/** Trimmed, blanks dropped, and a dark cover only beside a cover — what the server keeps. */
export function cleanPin(pin: PinDef): PinDef {
  const cover = pin.cover?.trim();
  const dark = pin.cover_dark?.trim();
  return {
    topic: pin.topic.trim(),
    ...(pin.color?.trim() ? { color: pin.color.trim() } : {}),
    ...(pin.icon?.trim() ? { icon: pin.icon.trim() } : {}),
    ...(cover ? { cover } : {}),
    ...(cover && dark ? { cover_dark: dark } : {}),
  };
}

/** Topics the "Pin a topic" picker offers: not already pinned, except the pin being edited. */
export function pinnableTopics<T extends PinTopicRef>(topics: readonly T[], pins: readonly Pick<PinDef, 'topic'>[], editing: string | null): T[] {
  return topics.filter((t) => (editing !== null && (t.slug === editing || t.id === editing)) || !pins.some((p) => pinMatchesTopic(p, t)));
}

export interface PinProblems {
  topic?: string;
  cover_dark?: string;
}

export function pinDialogProblems(pin: PinDef): PinProblems {
  const problems: PinProblems = {};
  if (!pin.topic.trim()) problems.topic = 'Choose a topic.';
  const dark = pinRowProblems([pin])[0];
  if (dark) problems.cover_dark = dark;
  return problems;
}

/** A pin write the stored list refuses; the message is for the admin. */
export class PinWriteRefused extends Error {}

/**
 * Add a pin, or replace the one named `editing`. Applied to the list AS STORED
 * NOW, so it refuses what the server would otherwise silently drop: a seventh
 * pin (the server slices to six) or a topic someone else pinned meanwhile.
 */
export function upsertPin(pins: readonly PinDef[], editing: string | null, next: PinDef): PinDef[] {
  const clean = cleanPin(next);
  const at = editing === null ? -1 : pins.findIndex((p) => p.topic === editing);
  const duplicate = pins.findIndex((p, i) => i !== at && p.topic === clean.topic);
  if (duplicate !== -1) throw new PinWriteRefused(`${clean.topic} is already pinned.`);
  if (at === -1) {
    if (!canAddPin(pins.length)) throw new PinWriteRefused(`The home page already features ${MAX_PINNED_TOPICS} topics. Unpin one first.`);
    return [...pins, clean];
  }
  return pins.map((p, i) => (i === at ? clean : p));
}

export function removePin(pins: readonly PinDef[], topic: string): PinDef[] {
  return pins.filter((p) => p.topic !== topic);
}

/** Undo of an unpin: back at its old position, unless it was re-pinned meanwhile or the list is full. */
export function restorePin(pins: readonly PinDef[], pin: PinDef, index: number): PinDef[] {
  if (pins.some((p) => p.topic === pin.topic) || !canAddPin(pins.length)) return [...pins];
  const next = [...pins];
  next.splice(Math.max(0, Math.min(index, next.length)), 0, pin);
  return next;
}

/** Put the pins in `orderedTopics` order; pins not named keep their relative order after them. */
export function orderPins<T extends Pick<PinDef, 'topic'>>(pins: readonly T[], orderedTopics: readonly string[]): T[] {
  const rank = new Map(orderedTopics.map((t, i) => [t, i]));
  return pins
    .map((pin, i) => ({ pin, i }))
    .sort((a, b) => (rank.get(a.pin.topic) ?? orderedTopics.length + a.i) - (rank.get(b.pin.topic) ?? orderedTopics.length + b.i))
    .map(({ pin }) => pin);
}
