/**
 * One file's detail sheet (`?file=<id>`, the admin UX review §4.9):
 * a preview, what it is, its URL with Copy, and — the part the old card could
 * not answer — which items use it, each a link to that item. Delete sits at the
 * foot with the same rule as the list's menu: disabled with the reason in text
 * while anything uses the file.
 *
 * The page owns the URL, the delete confirmation and the clipboard; this is layout.
 */
import { Link } from '@tanstack/react-router';
import { Sheet } from '../../components/admin/Sheet.js';
import { StatusChip } from '../../components/admin/StatusChip.js';
import { Icon, appIcons } from '../../icons.js';
import type { ImageAsset } from '../../queries.js';
import { absoluteTime, shortDate } from '../users/usersModel.js';
import { deleteBlockedReason, fileDisplayName, humanSize, isRaster, typeLabel, usageLabel } from './filesModel.js';
import type { FileDetail } from './queries.js';

/**
 * Usage as text. Unused is a neutral fact — often exactly what the admin is
 * looking for — so it is a grey chip, never the error colour the old card used.
 */
export function UsageBadge({ asset }: { asset: Pick<ImageAsset, 'used_by' | 'orphan' | 'site_asset'> }): JSX.Element {
  if (asset.orphan) {
    return (
      <span className="Files__chip" data-testid="file-usage">
        {usageLabel(asset)}
      </span>
    );
  }
  return (
    <span className="Files__usage" data-testid="file-usage">
      {usageLabel(asset)}
    </span>
  );
}

export interface FileDetailSheetProps {
  /** The row already on screen, shown while the detail loads. */
  file: ImageAsset;
  detail: FileDetail | undefined;
  detailLoading: boolean;
  detailError: boolean;
  onRetry: () => void;
  onClose: () => void;
  onCopyUrl: () => void;
  onCopyMarkdown: () => void;
  onDownload: () => void;
  onDelete: () => void;
}

export function FileDetailSheet({ file, detail, detailLoading, detailError, onRetry, onClose, onCopyUrl, onCopyMarkdown, onDownload, onDelete }: FileDetailSheetProps): JSX.Element {
  // The detail is fresher than the list row (someone may have used the file since).
  const current: ImageAsset = detail ?? file;
  const name = fileDisplayName(current);
  const blocked = deleteBlockedReason(current);

  return (
    <Sheet
      title={name}
      subtitle={<UsageBadge asset={current} />}
      onClose={onClose}
    >
      <div className="Files__sheet" data-testid="file-detail">
        <div className="Files__preview">
          {isRaster(current.mime) ? (
            <img src={current.url} alt={current.alt ?? ''} className="Files__previewImg" />
          ) : (
            <span className="Files__glyph Files__glyph--large" aria-hidden="true">
              <Icon icon={appIcons.fileLines} fixedWidth={false} />
              <span className="Files__glyphExt">{typeLabel(current.mime)}</span>
            </span>
          )}
        </div>

        <dl className="Files__facts">
          <dt>Name</dt>
          <dd>{name}</dd>
          <dt>Size</dt>
          <dd>{humanSize(current.byte_size)}</dd>
          <dt>Type</dt>
          <dd>
            {typeLabel(current.mime)} <span className="Files__muted">({current.mime})</span>
          </dd>
          <dt>Uploaded</dt>
          <dd>
            <time dateTime={current.created_at} title={absoluteTime(current.created_at)}>
              {shortDate(current.created_at)}
            </time>
            {detail?.created_by_username ? <> by {detail.created_by_username}</> : null}
          </dd>
          {current.alt ? (
            <>
              <dt>Alt text</dt>
              <dd>{current.alt}</dd>
            </>
          ) : null}
          <dt>URL</dt>
          <dd className="Files__urlRow">
            <code className="Files__url">{current.url}</code>
            <button type="button" className="kp-admin-button Files__smallButton" onClick={onCopyUrl}>
              <Icon icon={appIcons.copy} /> Copy URL
            </button>
          </dd>
        </dl>

        <div className="Files__sheetActions">
          <button type="button" className="kp-admin-button Files__smallButton" onClick={onCopyMarkdown}>
            Copy Markdown
          </button>
          <button type="button" className="kp-admin-button Files__smallButton" onClick={onDownload}>
            Download
          </button>
        </div>

        <section className="Files__usedBy" aria-labelledby="file-used-by-title">
          <h3 id="file-used-by-title" className="Files__sectionTitle">
            Used by
          </h3>
          <UsedByList file={current} detail={detail} loading={detailLoading} error={detailError} onRetry={onRetry} />
        </section>

        <div className="Files__sheetFoot">
          {blocked ? (
            <p className="Files__blocked" data-testid="file-delete-blocked">
              {blocked}. Remove it from {current.used_by > 0 ? 'those items' : 'the site settings'} to delete it.
            </p>
          ) : null}
          <button type="button" className="kp-admin-button Files__danger" onClick={onDelete} disabled={Boolean(blocked)}>
            Delete…
          </button>
        </div>
      </div>
    </Sheet>
  );
}

function UsedByList({ file, detail, loading, error, onRetry }: { file: ImageAsset; detail: FileDetail | undefined; loading: boolean; error: boolean; onRetry: () => void }): JSX.Element {
  if (!detail) {
    if (error) {
      return (
        <p className="Files__muted" role="alert">
          Couldn&apos;t load where this file is used.{' '}
          <button type="button" className="kp-admin-button Files__smallButton" onClick={onRetry}>
            Retry
          </button>
        </p>
      );
    }
    return <p className="Files__muted">{loading ? 'Loading…' : null}</p>;
  }

  const items = detail.used_by_items;
  return (
    <>
      {file.site_asset ? (
        <p className="Files__siteNote">
          The site uses this file as its logo, favicon or a{' '}
          <Link to="/admin/sections/pinned">pinned-topic cover</Link>.
        </p>
      ) : null}
      {items.length === 0 && !file.site_asset ? <p className="Files__muted">No item uses this file. It is safe to delete.</p> : null}
      {items.length > 0 ? (
        <ul className="Files__usedByList">
          {items.map((item) => (
            <li key={item.item_id} className="Files__usedByItem">
              {item.deleted ? (
                <span className="Files__usedByTitle">{item.title}</span>
              ) : (
                <Link to="/p/$slug" params={{ slug: item.slug }} className="Files__usedByTitle">
                  {item.title}
                </Link>
              )}
              <span className="Files__usedByMeta">
                {item.topic ? <span>{item.topic.name}</span> : null}
                {item.topic?.visibility === 'private' ? <StatusChip tone="info" size="sm" label="Private topic" /> : null}
                {item.status === 'draft' ? <StatusChip tone="pending" size="sm" label="Draft" /> : null}
                {item.deleted ? <StatusChip tone="warn" size="sm" label="In trash" title="Restore or purge the item to release the file" /> : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {detail.used_by > items.length ? (
        <p className="Files__muted">and {(detail.used_by - items.length).toLocaleString('en-US')} more</p>
      ) : null}
    </>
  );
}
