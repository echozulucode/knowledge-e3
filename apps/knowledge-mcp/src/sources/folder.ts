/**
 * `folder` source: Markdown files in a local directory, read once into an
 * in-memory index. Nothing is ever written, and nothing outside the configured
 * directory is read (see `paths.ts`).
 */
import { readFileSync, statSync } from 'node:fs';
import { isConceptPath, isIndexablePath, type ItemSelection } from '@echozedlabs/content-store';
import { toMcpItem, type ItemRefInput, type SearchToolInput } from '@echozedlabs/mcp-tools';
import { parseBundleIndex } from '@echozedlabs/okf';
import type { FolderSourceConfig, GitSourceConfig } from '../config.js';
import { LocalIndex, type TopicPresentation } from '../index/local-index.js';
import type { Logger } from '../log.js';
import { MAX_FILE_BYTES, realRoot, safeFile, walkFiles } from '../paths.js';
import { conceptToLocalItem, slugify, type LocalItem } from './concept.js';
import type { KnowledgeSource, SourceInfo, SourceItem, SourceVocabulary } from './types.js';

export interface LocalLoadResult {
  index: LocalIndex;
  root: string;
  skipped: string[];
}

/** Read every item file under a local source's root into a fresh index. */
export function loadLocalIndex(config: FolderSourceConfig | GitSourceConfig, logger: Logger, now: () => Date = () => new Date()): LocalLoadResult {
  const root = realRoot(config.path);
  const walk = walkFiles(root);
  for (const link of walk.skippedLinks) logger.debug(`[${config.id}] not following link: ${link}`);
  const markdown = walk.files.filter((f) => f.toLowerCase().endsWith('.md'));
  const selection = selectionFor(config, markdown);
  const recordedIds = readRecordedIds(root, logger, config.id);
  const items: LocalItem[] = [];
  const skipped: string[] = [];
  const seenIds = new Set<string>();
  for (const path of markdown) {
    if (!isIndexablePath(path, selection)) continue;
    const abs = safeFile(root, path);
    if (!abs) {
      skipped.push(path);
      continue;
    }
    const stat = statSync(abs);
    if (stat.size > MAX_FILE_BYTES) {
      logger.warn(`[${config.id}] skipping ${path}: larger than ${MAX_FILE_BYTES} bytes`);
      skipped.push(path);
      continue;
    }
    try {
      const item = conceptToLocalItem({
        path,
        raw: readFileSync(abs, 'utf8'),
        mtime: stat.mtime,
        defaultStatus: config.default_status,
        recordedIds,
        now: now(),
        ...(config.topic ? { defaultTopic: config.topic } : {}),
      });
      if (seenIds.has(item.id)) {
        logger.warn(`[${config.id}] skipping ${path}: duplicate item id ${item.id}`);
        skipped.push(path);
        continue;
      }
      seenIds.add(item.id);
      items.push(item);
    } catch (err) {
      logger.warn(`[${config.id}] skipping ${path}: ${err instanceof Error ? err.message : String(err)}`);
      skipped.push(path);
    }
  }
  return { index: new LocalIndex(config.id, items, presentationsFor(root, config, walk.files), now), root, skipped };
}

/**
 * Which files are items. Configured globs win. Otherwise a directory that uses
 * the OKF layout (`concepts/` or `<topic>/concepts/`) is read exactly as the
 * server reads it, and any other directory is read as plain notes (every `*.md`).
 */
function selectionFor(config: FolderSourceConfig | GitSourceConfig, markdown: string[]): ItemSelection {
  if (config.include?.length) return { include: config.include, exclude: config.exclude ?? [] };
  if (markdown.some((path) => isConceptPath(path))) return { exclude: config.exclude ?? [] };
  return { include: ['**/*.md'], exclude: config.exclude ?? [] };
}

/** `index.md` presentation: the root file presents the source's default topic; `<topic>/index.md` its subtree topic. */
function presentationsFor(root: string, config: FolderSourceConfig | GitSourceConfig, files: string[]): Map<string, TopicPresentation> {
  const out = new Map<string, TopicPresentation>();
  for (const path of files) {
    const m = /^(?:([^/]+)\/)?index\.md$/.exec(path);
    if (!m) continue;
    const topic = m[1] ?? config.topic;
    if (!topic) continue;
    const abs = safeFile(root, path);
    if (!abs) continue;
    try {
      const info = parseBundleIndex(readFileSync(abs, 'utf8'));
      out.set(slugify(topic), {
        ...(info.presentation ? { presentation: info.presentation } : {}),
        ...(info.start_here ? { start_here: info.start_here } : {}),
        ...(info.landing_markdown ? { landing_markdown: info.landing_markdown } : {}),
      });
    } catch {
      // A malformed index never costs the source its items.
    }
  }
  return out;
}

/** `.e3/ids.json`, where the server keeps ids for files it imported without writing to them. Tolerant; never written. */
function readRecordedIds(root: string, logger: Logger, id: string): Record<string, string> {
  const abs = safeFile(root, '.e3/ids.json');
  if (!abs) return {};
  try {
    const doc = JSON.parse(readFileSync(abs, 'utf8')) as Record<string, unknown>;
    const ids = doc && typeof doc['ids'] === 'object' && doc['ids'] !== null ? (doc['ids'] as Record<string, unknown>) : doc;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(ids ?? {})) if (typeof v === 'string' && v.trim()) out[k.replace(/\\/g, '/')] = v.trim();
    return out;
  } catch {
    logger.warn(`[${id}] ignoring unreadable .e3/ids.json`);
    return {};
  }
}

export function localSourceItem(sourceId: string, item: LocalItem): SourceItem {
  const { url: _url, ...rest } = toMcpItem(item);
  return { source: sourceId, ref: `${sourceId}:${item.id}`, ...rest, path: item.file };
}

/** Shared by the folder and git sources: the index answers every read. */
export abstract class LocalSourceBase implements KnowledgeSource {
  abstract readonly type: 'folder' | 'git';
  protected index: LocalIndex | null = null;
  protected loadError: string | null = null;

  constructor(
    protected readonly config: FolderSourceConfig | GitSourceConfig,
    protected readonly logger: Logger,
  ) {}

  get id(): string {
    return this.config.id;
  }

  async load(): Promise<void> {
    try {
      const { index, skipped } = loadLocalIndex(this.config, this.logger);
      this.index = index;
      this.loadError = null;
      this.logger.info(`[${this.id}] indexed ${index.size} item(s)${skipped.length ? `, skipped ${skipped.length}` : ''}`);
    } catch (err) {
      this.loadError = err instanceof Error ? err.message : String(err);
      this.logger.error(`[${this.id}] could not be read: ${this.loadError}`);
    }
  }

  protected ready(): LocalIndex {
    if (!this.index) throw new Error(`source ${this.id} is not loaded${this.loadError ? `: ${this.loadError}` : ''}`);
    return this.index;
  }

  async search(input: SearchToolInput): Promise<Record<string, unknown>> {
    return { ...(await this.ready().search(input)) };
  }

  async getItem(ref: ItemRefInput): Promise<SourceItem | null> {
    const index = this.ready();
    const item = ref.id ? index.find(ref.id) : ref.slug ? index.find(ref.slug) : ref.title ? index.findByTitle(ref.title) : null;
    return item ? localSourceItem(this.id, item) : null;
  }

  async listSpaces(): Promise<object[]> {
    return this.ready()
      .topics()
      .map((t) => ({ source: this.id, ...t }));
  }

  async listTaxonomy() {
    const t = this.ready().taxonomy();
    const tag = <T extends object>(list: T[]) => list.map((e) => ({ source: this.id, ...e }));
    return { tags: tag(t.tags), categories: tag(t.categories), groups: tag(t.groups) };
  }

  async vocabulary(): Promise<SourceVocabulary> {
    return this.ready().vocabulary();
  }

  info(): SourceInfo {
    return {
      id: this.id,
      type: this.type,
      status: this.index ? 'ready' : 'error',
      path: this.config.path,
      ...(this.index ? { items: this.index.size, topics: this.index.topics().map((t) => t.slug) } : {}),
      ...(this.loadError ? { error: this.loadError } : {}),
    };
  }
}

export class FolderSource extends LocalSourceBase {
  readonly type = 'folder' as const;
}
