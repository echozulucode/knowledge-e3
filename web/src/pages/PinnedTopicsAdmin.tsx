/**
 * PinnedTopicsAdmin — `/admin/sections/pinned`: the home page's featured
 * topics (the admin UX review §4.2).
 *
 * It used to be a second editable table at the foot of the Sections page:
 * topic slugs typed by hand, colours and icons as camelCase `<select>`s, covers
 * as pasted `/assets/…` URLs, and one Save for the lot. Now the pins are shown
 * as what they are — `PinnedTopicCard`s, in home-page order — and each change
 * is one small, immediate write:
 *   - Pin / Edit: an `EditDialog` (five fields) with a live preview of the card
 *     in the light and dark theme;
 *   - reorder and unpin: saved at once, with Undo in the toast (review §3.3).
 *
 * Only an administrator may say which topics the company features; the server
 * refuses a non-admin `PUT /site/pinned` regardless. Rules kept from the old
 * editor (pinnedTopicsModel.ts): at most six, said in text next to the disabled
 * button; a dark theme cover only beside a cover. A private topic may be pinned
 * — the server drops it for anonymous visitors (`SiteController.resolvePins`)
 * — so the picker flags it rather than hiding it.
 */
import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { PinnedTopicCard } from '@echozedlabs/ui';
import { AdminPageHeader } from '../components/admin/AdminPageHeader.js';
import { AssetPicker } from '../components/admin/AssetPicker.js';
import { ConfirmDialog } from '../components/admin/ConfirmDialog.js';
import { EditDialog } from '../components/admin/EditDialog.js';
import { EmptyState } from '../components/admin/EmptyState.js';
import { FormField } from '../components/admin/FormField.js';
import { IconPicker } from '../components/admin/IconPicker.js';
import { OverflowMenu } from '../components/admin/OverflowMenu.js';
import { ReferencePicker } from '../components/admin/ReferencePicker.js';
import { ReorderList, moveItem } from '../components/admin/ReorderList.js';
import { StatusChip } from '../components/admin/StatusChip.js';
import { SwatchPicker } from '../components/admin/SwatchPicker.js';
import { colorName } from '../components/admin/choicePickerModel.js';
import { usePinnedTopics } from '../components/shell/SiteBrand.js';
import type { PinnedTopic } from '../components/shell/siteBranding.js';
import { TopicIcon, isPinIcon } from '../features/home/topicIcons.js';
import type { TopicListEntry } from '../features/topic/queries.js';
import { pushToast } from '../hooks/useToast.js';
import { Icon, appIcons } from '../icons.js';
import { pinInputFromView, useTopics, useUpdatePinnedTopics } from '../queries.js';
import { ordinal } from './sectionsAdminModel.js';
import {
  MAX_PINNED_TOPICS,
  PinWriteRefused,
  canAddPin,
  pinCountLabel,
  pinDialogProblems,
  pinnableTopics,
  orderPins,
  removePin,
  restorePin,
  upsertPin,
  type PinDef,
} from './pinnedTopicsModel.js';
import { SectionsSubnav } from './SectionsAdmin.js';
import './SectionsAdmin.css';
import './PinnedTopicsAdmin.css';

const BLANK_PIN: PinDef = { topic: '', color: '', icon: '', cover: '', cover_dark: '' };

type DialogState = { mode: 'add' } | { mode: 'edit'; topic: string };

function undoFailed(): void {
  pushToast({ kind: 'error', message: 'Undo failed. Reload the page to see what is saved.' });
}

export function PinnedTopicsAdmin(): JSX.Element {
  const queryClient = useQueryClient();
  // `data`, not `data: pins = []`: a defaulted array is new every render (the
  // effect-loop bug fixed in the old editor). Derived with useMemo instead.
  const { data, isLoading, isError, refetch } = usePinnedTopics();
  const { data: topicsData } = useTopics();
  const update = useUpdatePinnedTopics();
  const pins = useMemo(() => data ?? [], [data]);
  const topics = useMemo(() => (topicsData ?? []) as TopicListEntry[], [topicsData]);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [pendingUnpin, setPendingUnpin] = useState<{ pin: PinnedTopic; index: number } | null>(null);
  const [unpinError, setUnpinError] = useState<string | null>(null);
  const atCap = !canAddPin(pins.length);

  function nameOf(pin: PinnedTopic): string {
    return pin.name ?? topics.find((t) => t.slug === pin.topic || t.id === pin.topic)?.name ?? pin.topic;
  }

  function reorder(orderedTopics: string[]) {
    const previous = queryClient.getQueryData<PinnedTopic[]>(['site-pinned']);
    // Optimistic, so the card lands where it was dropped.
    queryClient.setQueryData<PinnedTopic[]>(['site-pinned'], (current) => (current ? orderPins(current, orderedTopics) : current));
    update.mutate((current) => orderPins(current, orderedTopics), {
      onSuccess: ({ before }) => {
        const beforeOrder = before.map((p) => p.topic);
        pushToast({
          kind: 'success',
          message: 'Order saved.',
          action: { label: 'Undo', onAction: () => update.mutate((current) => orderPins(current, beforeOrder), { onError: undoFailed }) },
        });
      },
      onError: () => {
        if (previous) queryClient.setQueryData(['site-pinned'], previous);
        pushToast({ kind: 'error', message: 'The new order could not be saved.' });
      },
    });
  }

  async function confirmUnpin() {
    if (!pendingUnpin) return;
    const { pin, index } = pendingUnpin;
    const removed = pinInputFromView(pin);
    setUnpinError(null);
    try {
      await update.mutateAsync((current) => removePin(current, pin.topic));
      setPendingUnpin(null);
      pushToast({
        kind: 'success',
        message: `Unpinned “${nameOf(pin)}”.`,
        action: { label: 'Undo', onAction: () => update.mutate((current) => restorePin(current, removed, index), { onError: undoFailed }) },
      });
    } catch {
      setUnpinError('The topic could not be unpinned. Nothing was changed.');
    }
  }

  return (
    <main className="PinnedTopicsAdmin" aria-labelledby="pinned-topics-title">
      <SectionsSubnav current="pinned" />
      <AdminPageHeader
        titleId="pinned-topics-title"
        title="Pinned topics"
        description="Topics featured beside the feed on the home page, in this order."
        meta={<span data-testid="pinned-topics-count">{pinCountLabel(pins.length)}</span>}
        primaryAction={
          <button type="button" className="kp-admin-button kp-admin-button--primary" onClick={() => setDialog({ mode: 'add' })} disabled={atCap || isLoading} aria-describedby={atCap ? 'pinned-topics-cap' : undefined}>
            <Icon icon={appIcons.plus} /> Pin a topic
          </button>
        }
        learnMore={
          <details>
            <summary>How pins work</summary>
            <p>
              Each pin can take a colour from a fixed palette (a rule and a tint — the topic&apos;s name always carries the
              meaning), an icon shown when there is no cover, and a cover image from Files. A cover is readable by anonymous
              visitors, the same way the site logo is. A pin whose topic no longer exists, or that a visitor may not see, is
              left out for them rather than breaking the page.
            </p>
          </details>
        }
      />
      {/* Disabled controls say why in text, not only a tooltip (review §3.3). */}
      {atCap ? (
        <p className="PinnedTopicsAdmin__cap" id="pinned-topics-cap">
          The home page features at most {MAX_PINNED_TOPICS} topics. Unpin one to pin another.
        </p>
      ) : null}

      {isLoading ? (
        <p role="status" className="PinnedTopicsAdmin__muted">
          Loading pinned topics…
        </p>
      ) : isError ? (
        <EmptyState
          title="Pinned topics could not be loaded"
          action={
            <button type="button" className="kp-admin-button" onClick={() => void refetch()}>
              Retry
            </button>
          }
        />
      ) : pins.length === 0 ? (
        <EmptyState
          title="No pinned topics"
          body="Pin up to six key topics to feature them beside the feed on the home page."
          action={
            <button type="button" className="kp-admin-button kp-admin-button--primary" onClick={() => setDialog({ mode: 'add' })}>
              <Icon icon={appIcons.plus} /> Pin a topic
            </button>
          }
        />
      ) : (
        <ReorderList<PinnedTopic>
          items={pins}
          getId={(p) => p.topic}
          itemLabel={nameOf}
          layout="grid"
          label="Pinned topics, in home page order"
          className="PinnedTopicsAdmin__grid"
          onReorder={reorder}
          renderItem={(pin, handle, index) => {
            const topic = topics.find((t) => t.slug === pin.topic || t.id === pin.topic);
            const ids = pins.map((p) => p.topic);
            return (
              <div className="PinnedTopicsAdmin__item" data-testid="pinned-topic-card">
                <PinnedTopicCard
                  name={nameOf(pin)}
                  href={`/topics/${pin.topic}`}
                  renderLink={({ className, children }) => (
                    <Link to="/topics/$slug" params={{ slug: pin.topic }} className={className}>
                      {children}
                    </Link>
                  )}
                  color={pin.color}
                  icon={isPinIcon(pin.icon) ? <TopicIcon token={pin.icon} /> : undefined}
                  cover={pin.cover}
                  coverDark={pin.cover_dark}
                />
                <div className="PinnedTopicsAdmin__footer">
                  {handle}
                  <span className="PinnedTopicsAdmin__facts">
                    <span>{ordinal(index + 1)}</span>
                    {pin.color ? (
                      <span className="PinnedTopicsAdmin__color">
                        <span className="PinnedTopicsAdmin__dot" aria-hidden="true" style={{ ['--kp-swatch' as string]: `var(--kp-pin-${pin.color})` }} />
                        {colorName(pin.color)}
                      </span>
                    ) : null}
                    {!pin.name ? <StatusChip tone="warn" size="sm" label="Topic not found" title="Hidden on the home page: no topic has this slug" /> : null}
                    {topic?.visibility === 'private' ? <StatusChip tone="info" size="sm" label="Private" title="Hidden from visitors who are not signed in" /> : null}
                  </span>
                  <OverflowMenu
                    label={`Actions for ${nameOf(pin)}`}
                    items={[
                      { id: 'edit', label: 'Edit', onSelect: () => setDialog({ mode: 'edit', topic: pin.topic }) },
                      {
                        id: 'left',
                        label: 'Move left',
                        disabledReason: index === 0 ? 'Already first' : undefined,
                        onSelect: () => reorder(moveItem(ids, index, index - 1)),
                      },
                      {
                        id: 'right',
                        label: 'Move right',
                        disabledReason: index === pins.length - 1 ? 'Already last' : undefined,
                        onSelect: () => reorder(moveItem(ids, index, index + 1)),
                      },
                      {
                        id: 'unpin',
                        label: 'Unpin…',
                        danger: true,
                        separatorBefore: true,
                        onSelect: () => {
                          setUnpinError(null);
                          setPendingUnpin({ pin, index });
                        },
                      },
                    ]}
                  />
                </div>
              </div>
            );
          }}
        />
      )}

      {dialog ? (
        <PinDialog
          key={dialog.mode === 'edit' ? dialog.topic : 'add'}
          dialog={dialog}
          pins={pins}
          topics={topics}
          onClose={() => setDialog(null)}
          onSave={async (next) => {
            const editing = dialog.mode === 'edit' ? dialog.topic : null;
            await update.mutateAsync((current) => upsertPin(current, editing, next));
            const name = topics.find((t) => t.slug === next.topic)?.name ?? next.topic;
            pushToast({ kind: 'success', message: editing ? `Saved the pin for “${name}”.` : `Pinned “${name}”.` });
            setDialog(null);
          }}
          saving={update.isPending}
        />
      ) : null}

      {pendingUnpin ? (
        <ConfirmDialog
          title={`Unpin “${nameOf(pendingUnpin.pin)}”?`}
          body="It is removed from the home page at once. You can undo from the message that follows."
          confirmLabel="Unpin"
          tone="danger"
          pending={update.isPending}
          error={unpinError}
          onConfirm={() => void confirmUnpin()}
          onCancel={() => setPendingUnpin(null)}
        />
      ) : null}
    </main>
  );
}

function PinDialog({
  dialog,
  pins,
  topics,
  onClose,
  onSave,
  saving,
}: {
  dialog: DialogState;
  pins: PinnedTopic[];
  topics: TopicListEntry[];
  onClose: () => void;
  onSave: (pin: PinDef) => Promise<void>;
  saving: boolean;
}) {
  const editing = dialog.mode === 'edit' ? dialog.topic : null;
  const start = useMemo<PinDef>(() => {
    const existing = editing ? pins.find((p) => p.topic === editing) : undefined;
    return existing ? { ...BLANK_PIN, ...pinInputFromView(existing) } : BLANK_PIN;
    // Once per dialog: the parent keys the dialog by the pin it edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [pin, setPin] = useState<PinDef>(start);
  const [error, setError] = useState<string | null>(null);
  const [darkOpen, setDarkOpen] = useState(Boolean(start.cover_dark));
  const problems = pinDialogProblems(pin);
  const isDirty = JSON.stringify(pin) !== JSON.stringify(start);
  const options = pinnableTopics(topics, pins, editing);
  const topic = topics.find((t) => t.slug === pin.topic || t.id === pin.topic);
  const hasCover = Boolean(pin.cover?.trim());

  function patch(next: Partial<PinDef>) {
    setPin((prev) => ({ ...prev, ...next }));
    setError(null);
  }

  async function submit() {
    if (problems.topic || problems.cover_dark) return;
    try {
      await onSave(pin);
    } catch (e) {
      setError(e instanceof PinWriteRefused ? e.message : 'The pin could not be saved.');
    }
  }

  const previewName = topic?.name ?? (pin.topic || 'Choose a topic');
  const previewIcon = isPinIcon(pin.icon) ? <TopicIcon token={pin.icon} /> : undefined;

  return (
    <EditDialog
      title={editing ? 'Edit pin' : 'Pin a topic'}
      open
      width="md"
      isDirty={isDirty}
      isSaving={saving}
      canSave={isDirty && !problems.topic && !problems.cover_dark}
      submitLabel={editing ? 'Save pin' : 'Pin topic'}
      error={error}
      onSubmit={() => void submit()}
      onClose={onClose}
    >
      <div className="PinnedTopicsAdmin__dialog">
        <div className="PinnedTopicsAdmin__fields">
          <FormField
            label="Topic"
            htmlFor="pin-topic"
            required
            helper={topic?.visibility === 'private' ? 'Private topic: the pin is hidden from visitors who are not signed in.' : 'Topics already pinned are not listed.'}
          >
            {(control) => (
              <ReferencePicker<TopicListEntry>
                id={control.id}
                aria-describedby={control['aria-describedby']}
                options={options}
                getKey={(t) => t.slug}
                getLabel={(t) => t.name}
                renderOption={(t) => (
                  <span className="PinnedTopicsAdmin__option">
                    <span>{t.name}</span>
                    {t.visibility === 'private' ? <span className="PinnedTopicsAdmin__muted">private</span> : null}
                  </span>
                )}
                value={pin.topic}
                onChange={(slug) => patch({ topic: slug })}
                invalidValueMessage={(v) => `Topic “${v}” was not found; the pin is hidden until it exists.`}
                placeholder="Search topics…"
              />
            )}
          </FormField>
          <SwatchPicker legend="Colour" name="pin-colour" value={pin.color} onChange={(color) => patch({ color })} />
          <IconPicker legend="Icon" name="pin-icon" value={pin.icon} onChange={(icon) => patch({ icon })} helper="Shown on the card when there is no cover." />
          <FormField label="Cover" htmlFor="pin-cover" helper="An image from Files, shown as the card's thumbnail.">
            {(control) => <AssetPicker id={control.id} label="Cover" aria-describedby={control['aria-describedby']} value={pin.cover ?? ''} onChange={(cover) => patch({ cover })} />}
          </FormField>
          <details className="PinnedTopicsAdmin__dark" open={darkOpen} onToggle={(e) => setDarkOpen((e.target as HTMLDetailsElement).open)}>
            <summary>Dark theme cover</summary>
            <FormField
              label="Dark theme cover"
              htmlFor="pin-cover-dark"
              labelHidden
              helper={hasCover ? 'Optional. Used in the dark theme; the cover is used when unset.' : 'Set a cover first. The dark theme cover only replaces a cover.'}
              error={problems.cover_dark}
            >
              {(control) => (
                <AssetPicker
                  id={control.id}
                  label="Dark theme cover"
                  aria-describedby={control['aria-describedby']}
                  value={pin.cover_dark ?? ''}
                  onChange={(cover_dark) => patch({ cover_dark })}
                  // A dark cover already set stays clearable, so the problem it causes can be fixed here.
                  disabled={!hasCover && !pin.cover_dark}
                />
              )}
            </FormField>
          </details>
        </div>
        <div className="PinnedTopicsAdmin__preview" aria-label="Preview" role="group">
          <p className="PinnedTopicsAdmin__previewTitle">Preview</p>
          <div className="PinnedTopicsAdmin__previewPair">
            <div className="PinnedTopicsAdmin__previewTheme">
              <span className="PinnedTopicsAdmin__muted">Light</span>
              {/* The light cover in both slots: the card picks by the PAGE's theme, and this preview must show the light one whatever that is. */}
              <PinnedTopicCard name={previewName} href="#" renderLink={({ className, children }) => <span className={className}>{children}</span>} color={pin.color} icon={previewIcon} cover={pin.cover || null} coverDark={pin.cover || null} testId="pin-preview-light" />
            </div>
            <div className="PinnedTopicsAdmin__previewTheme" data-theme="dark">
              <span className="PinnedTopicsAdmin__muted">Dark</span>
              <PinnedTopicCard
                name={previewName}
                href="#"
                renderLink={({ className, children }) => <span className={className}>{children}</span>}
                color={pin.color}
                icon={previewIcon}
                cover={(pin.cover && (pin.cover_dark || pin.cover)) || null}
                coverDark={(pin.cover && (pin.cover_dark || pin.cover)) || null}
                testId="pin-preview-dark"
              />
            </div>
          </div>
        </div>
      </div>
    </EditDialog>
  );
}
