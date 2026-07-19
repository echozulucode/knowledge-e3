import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { parse } from '@echozedlabs/codec';
import { slugify } from '../../common/slug.js';
import { AuditService } from '../../audit/audit.service.js';
import { ItemsService, type ItemView } from '../../items/items.service.js';
import type { McpTool, McpToolDescriptor } from './schemas.js';
import { stringProp } from './schemas.js';

export interface McpCreateItemClientContext {
  name?: string;
  version?: string;
  session_id?: string;
}

export interface McpCreateItemInput extends Record<string, unknown> {
  title?: string;
  body?: string;
  raw?: string;
  raw_markdown?: string;
  space?: string;
  status?: 'draft' | 'published';
  tags?: string[];
  categories?: string[];
  groups?: string[];
  frontmatter?: Record<string, unknown>;
  client_request_id?: string;
  source_fingerprint?: string;
  client?: McpCreateItemClientContext;
}

export interface McpCreateItemResponse {
  id: string;
  title: string;
  slug: string;
  path: string;
  url: string;
  version_token: number;
  indexing_status: 'indexed';
  warnings: string[];
  duplicate_title: DuplicateTitleDiagnostics;
  idempotency: { replayed: boolean; key: string | null };
  item: ItemView;
}

interface DuplicateTitleDiagnostics {
  checked: true;
  duplicate: boolean;
  scope: string;
  matches: Array<{ id: string; title: string; slug: string }>;
}

interface NormalizedMcpCreateItemInput {
  title: string;
  body?: string;
  raw?: string;
  raw_markdown?: string;
  status: 'draft' | 'published';
  tags?: string[];
  categories?: string[];
  groups?: string[];
  space?: string;
  frontmatter: Record<string, unknown>;
  client_request_id?: string;
  source_fingerprint: string;
  client?: McpCreateItemClientContext;
}

@Injectable()
export class CreateItemTool implements McpTool<McpCreateItemInput & { actor_id?: string }, McpCreateItemResponse> {
  readonly descriptor: McpToolDescriptor = {
    name: 'knowledge.create_item',
    title: 'Create a draft knowledge item',
    write: true,
    description:
      'Create a validated draft knowledge item from an MCP client. Returns canonical id first, slug/title display metadata, id-based path, legacy slug URL, version token, indexing status, validation warnings, duplicate-title diagnostics, and idempotency replay metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        actor_id: stringProp('Authenticated user id to attribute the create to.'),
        title: stringProp('Display title for the new item. Required unless raw markdown frontmatter contains title.'),
        body: stringProp('Markdown body text.'),
        raw: stringProp('Full raw Markdown document with optional frontmatter.'),
        raw_markdown: stringProp('Full raw Markdown document with optional frontmatter.'),
        space: stringProp('Space/topic display name or slug.'),
        status: stringProp('Lifecycle status. Defaults to draft.', ['draft', 'published']),
        client_request_id: stringProp('Optional idempotency key supplied by the MCP client.'),
        source_fingerprint: stringProp('Optional source fingerprint for replay protection.'),
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags to attach.' },
        categories: { type: 'array', items: { type: 'string' }, description: 'Categories to attach.' },
        groups: { type: 'array', items: { type: 'string' }, description: 'Groups to attach.' },
        frontmatter: { type: 'object', description: 'Additional frontmatter metadata.' },
        client: { type: 'object', description: 'MCP client name/version/session context.' },
      },
      additionalProperties: false,
    },
  };

  constructor(
    private readonly items: ItemsService,
    private readonly audit: AuditService,
  ) {}

  async call(input: McpCreateItemInput & { actor_id?: string }): Promise<McpCreateItemResponse> {
    const actorId = typeof input.actor_id === 'string' && input.actor_id.trim() ? input.actor_id.trim() : 'mcp-agent';
    return this.execute(actorId, input);
  }

  async execute(actorId: string, input: McpCreateItemInput): Promise<McpCreateItemResponse> {
    const normalized = normalizeInput(input);
    const idempotencyKey = idempotencyKeyFor(normalized);
    const source = {
      type: 'mcp',
      tool: 'create_item',
      client: normalized.client ?? {},
      client_request_id: normalized.client_request_id,
      fingerprint: normalized.source_fingerprint,
    };

    if (idempotencyKey) {
      const replay = await this.findExistingMcpCreate(normalized, idempotencyKey);
      if (replay) {
        return buildResponse(replay, {
          warnings: ['idempotent replay: returning existing MCP-created item'],
          duplicateTitle: await this.duplicateDiagnostics(normalized),
          idempotency: { replayed: true, key: idempotencyKey },
        });
      }
    }

    const duplicateTitle = await this.duplicateDiagnostics(normalized);
    if (duplicateTitle.duplicate) {
      throw new ConflictException({
        message: `An item titled "${normalized.title}" already exists in this topic`,
        duplicate_title: duplicateTitle,
      });
    }

    const item = await this.items.create(actorId, {
      title: normalized.title,
      body: normalized.body,
      raw: normalized.raw,
      raw_markdown: normalized.raw_markdown,
      status: normalized.status,
      tags: normalized.tags,
      frontmatter: {
        ...normalized.frontmatter,
        ...(normalized.space ? { space: normalized.space } : {}),
        ...(normalized.categories ? { categories: normalized.categories } : {}),
        ...(normalized.groups ? { groups: normalized.groups } : {}),
        source,
      },
    });

    await this.audit.record({
      actor_id: actorId,
      action: 'mcp.create_item',
      page_id: item.id,
      version_id: item.current_version_id,
      payload: {
        tool: 'create_item',
        client: normalized.client ?? null,
        client_request_id: normalized.client_request_id ?? null,
        source_fingerprint: normalized.source_fingerprint,
      },
    });

    return buildResponse(item, {
      warnings: [],
      duplicateTitle,
      idempotency: { replayed: false, key: idempotencyKey },
    });
  }

  private async findExistingMcpCreate(
    input: NormalizedMcpCreateItemInput,
    idempotencyKey: string,
  ): Promise<ItemView | null> {
    const candidates = await this.items.list({ q: input.title, limit: 1000 });
    return candidates.find((item) => {
      if (item.title !== input.title) return false;
      const source = sourceFromItem(item);
      if (idempotencyKey.startsWith('client_request_id:')) {
        return source.client_request_id === input.client_request_id && sameScope(spaceFromItem(item), input.space);
      }
      return source.fingerprint === input.source_fingerprint && sameScope(spaceFromItem(item), input.space);
    }) ?? null;
  }

  private async duplicateDiagnostics(input: NormalizedMcpCreateItemInput): Promise<DuplicateTitleDiagnostics> {
    const scope = scopeSlug(input.space);
    const candidates = await this.items.list({ q: input.title, limit: 1000 });
    const matches = candidates
      .filter((item) => item.title === input.title && scopeSlug(spaceFromItem(item)) === scope)
      .map((item) => ({ id: item.id, title: item.title, slug: item.slug }));
    return { checked: true, duplicate: matches.length > 0, scope, matches };
  }
}

function normalizeInput(input: McpCreateItemInput): NormalizedMcpCreateItemInput {
  const raw = input.raw_markdown ?? input.raw;
  const parsed = raw !== undefined ? parse(raw) : null;
  const inputFrontmatter = normalizeRecord(input.frontmatter, 'frontmatter');
  const client = normalizeClient(input.client);
  const mergedFrontmatter = { ...(parsed?.frontmatter ?? {}), ...(inputFrontmatter ?? {}) };
  const title = firstString(input.title, mergedFrontmatter['title'])?.trim();
  if (!title) throw new BadRequestException('title is required');
  if (title.length > 500) throw new BadRequestException('title too long');

  const body = input.body ?? parsed?.body;
  if (body !== undefined && typeof body !== 'string') throw new BadRequestException('body must be Markdown text');

  const space = firstString(input.space, mergedFrontmatter['space'], mergedFrontmatter['topic'])?.trim();
  if (space !== undefined && space.length === 0) throw new BadRequestException('space must be a non-empty string');

  const status = normalizeStatus(input.status ?? mergedFrontmatter['status']);
  const tags = normalizeStringArray(input.tags ?? mergedFrontmatter['tags'], 'tags');
  const categories = normalizeStringArray(input.categories ?? mergedFrontmatter['categories'], 'categories');
  const groups = normalizeStringArray(input.groups ?? mergedFrontmatter['groups'], 'groups');
  const fingerprint = input.source_fingerprint?.trim() || fingerprintFor({ title, body: body ?? '', raw, space, status, tags, categories, groups });

  return {
    title,
    body,
    raw: input.raw,
    raw_markdown: input.raw_markdown,
    status,
    tags,
    categories,
    groups,
    space,
    frontmatter: mergedFrontmatter,
    client_request_id: input.client_request_id?.trim() || undefined,
    source_fingerprint: fingerprint,
    client,
  };
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string');
}

function normalizeStatus(value: unknown): 'draft' | 'published' {
  if (value === undefined || value === null) return 'draft';
  if (value === 'draft' || value === 'published') return value;
  throw new BadRequestException('invalid status');
}

function normalizeStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new BadRequestException(`${field} must be a list of strings`);
  }
  return Array.from(new Set(value.map((entry) => entry.trim()).filter(Boolean))).sort();
}

function normalizeRecord(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function normalizeClient(value: unknown): McpCreateItemClientContext | undefined {
  const record = normalizeRecord(value, 'client');
  if (!record) return undefined;
  for (const field of ['name', 'version', 'session_id'] as const) {
    const fieldValue = record[field];
    if (fieldValue !== undefined && typeof fieldValue !== 'string') {
      throw new BadRequestException(`client.${field} must be a string`);
    }
  }
  const name = stringField(record, 'name');
  const version = stringField(record, 'version');
  const sessionId = stringField(record, 'session_id');
  return {
    ...(name ? { name } : {}),
    ...(version ? { version } : {}),
    ...(sessionId ? { session_id: sessionId } : {}),
  };
}

function stringField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function fingerprintFor(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function idempotencyKeyFor(input: NormalizedMcpCreateItemInput): string | null {
  if (input.client_request_id) return `client_request_id:${input.client_request_id}`;
  if (input.source_fingerprint) return `source_fingerprint:${input.source_fingerprint}`;
  return null;
}

function sourceFromItem(item: ItemView): { client_request_id?: string; fingerprint?: string } {
  const source = item.frontmatter['source'];
  if (!source || typeof source !== 'object') return {};
  const record = source as Record<string, unknown>;
  return {
    client_request_id: typeof record['client_request_id'] === 'string' ? record['client_request_id'] : undefined,
    fingerprint: typeof record['fingerprint'] === 'string' ? record['fingerprint'] : undefined,
  };
}

function spaceFromItem(item: ItemView): string | undefined {
  return firstString(item.frontmatter['space'], item.frontmatter['topic']);
}

function sameScope(a: string | undefined, b: string | undefined): boolean {
  return scopeSlug(a) === scopeSlug(b);
}

function scopeSlug(space: string | undefined): string {
  return space ? slugify(space) || 'default' : 'default';
}

function buildResponse(
  item: ItemView,
  opts: {
    warnings: string[];
    duplicateTitle: DuplicateTitleDiagnostics;
    idempotency: { replayed: boolean; key: string | null };
  },
): McpCreateItemResponse {
  return {
    id: item.id,
    title: item.title,
    slug: item.slug,
    path: `/items/${item.id}`,
    url: `/p/${item.slug}`,
    version_token: item.version_token,
    indexing_status: 'indexed',
    warnings: opts.warnings,
    duplicate_title: opts.duplicateTitle,
    idempotency: opts.idempotency,
    item,
  };
}
