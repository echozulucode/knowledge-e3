/**
 * ReferencePicker — choose existing things (topics, content types, tags, items)
 * instead of typing their slugs (the admin UX review §3.2).
 *
 * The Sections editor used to take a topic as a typed slug and tags as a
 * comma-separated string; a typo produced a section that silently matched
 * nothing. This is the ARIA 1.2 combobox + listbox pattern: an `<input
 * role="combobox">` owns a popup `role="listbox"`, the active row is announced
 * through `aria-activedescendant` (focus never leaves the input), and chosen
 * values in `multiple` mode are chips with their own Remove buttons.
 *
 * Options come from an array (`options`, optionally re-fed through
 * `onQueryChange` so a TanStack hook like `useTags(q)` does the searching) or
 * from `loadOptions(q)`. Filtering, chips and the Create row are pure and
 * tested in referencePickerModel.ts.
 *
 * Keyboard: ArrowDown/ArrowUp move (opening the list if closed), Enter chooses,
 * Esc closes the list (and only the list, inside a dialog — see
 * useEscapeLayer), Backspace in an empty input removes the last chip, Tab leaves.
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { addKey, buildRows, isUnknownValue, moveActive, removeKey, removeLastKey, type PickerRow } from './referencePickerModel.js';
import { useEscapeLayer } from './useEscapeLayer.js';
import './ReferencePicker.css';

interface CommonProps<T> {
  /** The input's id — pass the same value as `FormField`'s `htmlFor`. */
  id: string;
  options?: readonly T[];
  /** Async source; called (debounced) with the typed query while the list is open. */
  loadOptions?: (query: string) => Promise<T[]>;
  /** Told the query as it changes, for callers whose `options` come from a query hook. */
  onQueryChange?: (query: string) => void;
  /** The caller's own options are still loading. */
  loading?: boolean;
  getKey: (option: T) => string;
  getLabel: (option: T) => string;
  renderOption?: (option: T, state: { active: boolean; selected: boolean }) => ReactNode;
  /** Offer a "Create “x”" row for a value no option has. */
  allowCreate?: boolean;
  /** Single mode: a row meaning "no value", e.g. `{ label: 'Any type' }`. Chosen, it sets `''`. */
  emptyOption?: { label: string };
  /** Shown when the stored value is not among `options` (a deleted topic). Single mode, array options only. */
  invalidValueMessage?: (value: string) => string;
  placeholder?: string;
  disabled?: boolean;
  /** Accessible name when there is no visible `<label for={id}>`. */
  ariaLabel?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
  /** Cap on rendered option rows. Default 50. */
  maxOptions?: number;
  /** Label for a chosen key no loaded option names (async sources). Defaults to the key. */
  labelForKey?: (key: string) => string | undefined;
  /** Playwright hook on the wrapper. */
  testId?: string;
}

interface SingleProps<T> extends CommonProps<T> {
  multiple?: false;
  value: string;
  onChange: (key: string, option?: T) => void;
}

interface MultipleProps<T> extends CommonProps<T> {
  multiple: true;
  value: readonly string[];
  onChange: (keys: string[]) => void;
}

export type ReferencePickerProps<T> = SingleProps<T> | MultipleProps<T>;

const LOAD_DEBOUNCE_MS = 200;

function Chevron() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
      <path d="M3.5 6l4.5 4.5L12.5 6" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ReferencePicker<T>(props: ReferencePickerProps<T>): JSX.Element {
  const {
    id,
    options,
    loadOptions,
    onQueryChange,
    loading,
    getKey,
    getLabel,
    renderOption,
    allowCreate,
    emptyOption,
    invalidValueMessage,
    placeholder,
    disabled,
    ariaLabel,
    maxOptions = 50,
    labelForKey,
    testId,
  } = props;
  const multiple = props.multiple === true;
  const selected: readonly string[] = multiple ? (props.value as readonly string[]) : props.value ? [props.value as string] : [];

  const listId = useId();
  const invalidId = `${id}-invalid`;
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(-1);
  const [asyncOptions, setAsyncOptions] = useState<T[]>([]);
  const [asyncLoading, setAsyncLoading] = useState(false);
  // Labels seen so far, so a chip or the single value keeps its name after the
  // async list moves on to another query.
  const known = useRef(new Map<string, string>());

  const source: readonly T[] = loadOptions ? asyncOptions : (options ?? []);
  for (const o of source) known.current.set(getKey(o), getLabel(o));

  useEffect(() => {
    if (!loadOptions || !open) return;
    let cancelled = false;
    setAsyncLoading(true);
    const timer = setTimeout(() => {
      loadOptions(query)
        .then((result) => {
          if (!cancelled) setAsyncOptions(result);
        })
        .catch(() => {
          if (!cancelled) setAsyncOptions([]);
        })
        .finally(() => {
          if (!cancelled) setAsyncLoading(false);
        });
    }, LOAD_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [loadOptions, open, query]);

  const rows = useMemo(
    () =>
      buildRows({
        options: source,
        query,
        getKey,
        getLabel,
        selected,
        multiple,
        allowCreate: allowCreate === true,
        emptyOptionLabel: emptyOption?.label,
        idPrefix: listId,
        max: maxOptions,
      }),
    // `selected` is derived from props.value each render; its contents are the dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [source, query, getKey, getLabel, selected.join('\u0000'), multiple, allowCreate, emptyOption?.label, listId, maxOptions],
  );

  const labelOf = (key: string): string => known.current.get(key) ?? labelForKey?.(key) ?? key;

  function changeQuery(next: string) {
    setQuery(next);
    setActive(-1);
    onQueryChange?.(next);
  }

  function close() {
    setOpen(false);
    setActive(-1);
    if (!multiple && query) changeQuery('');
  }

  useEscapeLayer(open, close);

  function choose(row: PickerRow<T>) {
    if (props.multiple === true) {
      if (row.kind === 'empty') return;
      props.onChange(addKey(props.value, row.key));
      changeQuery('');
      inputRef.current?.focus();
      return;
    }
    if (row.kind === 'empty') props.onChange('');
    else if (row.kind === 'option') props.onChange(row.key, row.option);
    else props.onChange(row.key);
    setOpen(false);
    setActive(-1);
    changeQuery('');
  }

  function removeChip(key: string) {
    if (props.multiple !== true) return;
    props.onChange(removeKey(props.value, key));
    inputRef.current?.focus();
  }

  useEffect(() => {
    if (active < 0) return;
    const row = rows[active];
    if (row) document.getElementById(row.id)?.scrollIntoView?.({ block: 'nearest' });
  }, [active, rows]);

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        e.preventDefault();
        if (!open) {
          setOpen(true);
          setActive(e.key === 'ArrowDown' ? 0 : rows.length - 1);
          return;
        }
        setActive((current) => moveActive(current, e.key === 'ArrowDown' ? 1 : -1, rows.length));
        return;
      }
      case 'Enter': {
        if (!open) return;
        // Never submit the surrounding form while the list is open.
        e.preventDefault();
        const row = rows[active] ?? (rows.length === 1 ? rows[0] : undefined) ?? rows.find((r) => r.kind === 'create');
        if (row) choose(row);
        return;
      }
      case 'Backspace': {
        if (props.multiple === true && query === '' && props.value.length > 0) {
          e.preventDefault();
          props.onChange(removeLastKey(props.value));
        }
        return;
      }
      case 'Home':
      case 'End':
        if (open && rows.length) {
          e.preventDefault();
          setActive(e.key === 'Home' ? 0 : rows.length - 1);
        }
        return;
      case 'Tab':
        close();
        return;
      default:
        return;
    }
  }

  const singleValue = multiple ? '' : (props.value as string);
  const showInvalid = !multiple && !!invalidValueMessage && !!options && !loading && isUnknownValue(singleValue, options, getKey);
  const inputValue = open || multiple ? query : singleValue ? labelOf(singleValue) : (emptyOption?.label ?? '');
  const describedBy = [props['aria-describedby'], showInvalid ? invalidId : undefined].filter(Boolean).join(' ') || undefined;
  const busy = loading || asyncLoading;
  const activeRow = open ? rows[active] : undefined;

  return (
    <div className="kp-picker" data-multiple={multiple || undefined} data-open={open || undefined} data-testid={testId}>
      {multiple && selected.length > 0 ? (
        <ul className="kp-picker__chips" aria-label="Chosen">
          {selected.map((key) => (
            <li key={key} className="kp-picker__chip">
              <span className="kp-picker__chipLabel">{labelOf(key)}</span>
              <button type="button" className="kp-picker__chipRemove" onClick={() => removeChip(key)} aria-label={`Remove ${labelOf(key)}`} disabled={disabled}>
                <span aria-hidden="true">×</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="kp-picker__field">
        <input
          ref={inputRef}
          id={id}
          className="kp-picker__input"
          type="text"
          role="combobox"
          aria-label={ariaLabel}
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeRow?.id}
          aria-describedby={describedBy}
          aria-invalid={props['aria-invalid'] || showInvalid || undefined}
          aria-busy={busy || undefined}
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder}
          disabled={disabled}
          value={inputValue}
          onChange={(e) => {
            changeQuery(e.target.value);
            setOpen(true);
          }}
          onClick={() => setOpen(true)}
          onKeyDown={onKeyDown}
          onBlur={close}
        />
        <button
          type="button"
          className="kp-picker__toggle"
          tabIndex={-1}
          aria-hidden="true"
          disabled={disabled}
          // mousedown, so the input keeps focus and does not blur-close first.
          onMouseDown={(e) => {
            e.preventDefault();
            if (open) close();
            else {
              setOpen(true);
              inputRef.current?.focus();
            }
          }}
        >
          <Chevron />
        </button>
      </div>
      {/* Always in the DOM so `aria-controls` names a real element; hidden while closed. */}
      <div className="kp-picker__popup" hidden={!open}>
        <ul id={listId} role="listbox" className="kp-picker__list" aria-multiselectable={multiple || undefined} aria-label={ariaLabel ? `${ariaLabel} options` : undefined}>
          {rows.map((row, index) => {
            const isSelected = row.kind === 'empty' ? !multiple && singleValue === '' : row.kind === 'option' && selected.includes(row.key);
            return (
              <li
                key={row.id}
                id={row.id}
                role="option"
                aria-selected={isSelected}
                className="kp-picker__option"
                data-kind={row.kind}
                data-active={index === active || undefined}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(row)}
              >
                {row.kind === 'option' && renderOption ? renderOption(row.option, { active: index === active, selected: isSelected }) : row.label}
              </li>
            );
          })}
        </ul>
        {rows.length === 0 ? (
          <p className="kp-picker__none" role="status">
            {busy ? 'Loading…' : query.trim() ? 'No matches' : 'Nothing to choose from'}
          </p>
        ) : null}
      </div>
      {showInvalid ? (
        <p id={invalidId} className="kp-picker__invalid">
          {invalidValueMessage!(singleValue)}
        </p>
      ) : null}
    </div>
  );
}
