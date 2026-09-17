/**
 * ReferencePicker model — the pure half of the combobox (filtering, chips, the
 * "Create" row, keyboard movement), so the rules are unit-tested without a DOM.
 *
 * Keys are compared verbatim. Tags keep their case on the server
 * (`normalizeSectionTags` does not fold), so `Update` and `update` are two
 * different values; only the *search* and the "does this already exist" check
 * for the Create row ignore case, because offering "Create “update”" next to an
 * existing `Update` invites exactly the near-duplicate a picker exists to stop.
 */

export type PickerRow<T> =
  | { kind: 'empty'; id: string; label: string }
  | { kind: 'option'; id: string; key: string; label: string; option: T }
  | { kind: 'create'; id: string; key: string; label: string };

export interface BuildRowsInput<T> {
  options: readonly T[];
  query: string;
  getKey: (option: T) => string;
  getLabel: (option: T) => string;
  /** Keys already chosen. In multiple mode they are left out of the list (they are chips). */
  selected: readonly string[];
  multiple: boolean;
  allowCreate?: boolean;
  /** "Any type" / "All topics": a row meaning "no value", single mode only. */
  emptyOptionLabel?: string;
  /** Prefix for row ids (`aria-activedescendant` targets). */
  idPrefix: string;
  /** Cap on option rows, so a 5,000-tag instance renders a usable list. */
  max?: number;
}

export function matchesQuery(label: string, key: string, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return label.toLowerCase().includes(needle) || key.toLowerCase().includes(needle);
}

/** Label of the Create row, or undefined when there is nothing new to create. */
export function createRowLabel<T>(input: Pick<BuildRowsInput<T>, 'options' | 'query' | 'getKey' | 'getLabel' | 'selected' | 'allowCreate'>): string | undefined {
  const value = input.query.trim();
  if (!input.allowCreate || !value) return undefined;
  const lower = value.toLowerCase();
  const exists =
    input.selected.some((k) => k.toLowerCase() === lower) ||
    input.options.some((o) => input.getKey(o).toLowerCase() === lower || input.getLabel(o).toLowerCase() === lower);
  return exists ? undefined : `Create “${value}”`;
}

export function buildRows<T>(input: BuildRowsInput<T>): PickerRow<T>[] {
  const rows: PickerRow<T>[] = [];
  if (!input.multiple && input.emptyOptionLabel && !input.query.trim()) {
    rows.push({ kind: 'empty', id: `${input.idPrefix}-empty`, label: input.emptyOptionLabel });
  }
  const chosen = new Set(input.selected);
  const seen = new Set<string>();
  let count = 0;
  for (const option of input.options) {
    const key = input.getKey(option);
    const label = input.getLabel(option);
    if (seen.has(key)) continue;
    seen.add(key);
    if (input.multiple && chosen.has(key)) continue;
    if (!matchesQuery(label, key, input.query)) continue;
    if (input.max !== undefined && count >= input.max) break;
    rows.push({ kind: 'option', id: `${input.idPrefix}-opt-${count}`, key, label, option });
    count += 1;
  }
  const create = createRowLabel(input);
  if (create) rows.push({ kind: 'create', id: `${input.idPrefix}-create`, key: input.query.trim(), label: create });
  return rows;
}

/** Add a key once; blank keys are ignored. */
export function addKey(keys: readonly string[], key: string): string[] {
  const value = key.trim();
  if (!value || keys.includes(value)) return [...keys];
  return [...keys, value];
}

export function removeKey(keys: readonly string[], key: string): string[] {
  return keys.filter((k) => k !== key);
}

/** Backspace in an empty input removes the last chip. */
export function removeLastKey(keys: readonly string[]): string[] {
  return keys.slice(0, -1);
}

/** Arrow movement through the rows, wrapping at both ends; -1 means "nothing active". */
export function moveActive(current: number, delta: 1 | -1, count: number): number {
  if (count <= 0) return -1;
  if (current < 0) return delta === 1 ? 0 : count - 1;
  return (current + delta + count) % count;
}

/** A stored value that is not among the known options (a deleted topic, a retired type). */
export function isUnknownValue<T>(value: string, options: readonly T[], getKey: (option: T) => string): boolean {
  return value !== '' && !options.some((o) => getKey(o) === value);
}
