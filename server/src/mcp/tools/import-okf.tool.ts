import { Injectable } from '@nestjs/common';
import { validateBundle } from '@echozedlabs/okf';
import { AuthService } from '../../auth/auth.service.js';
import { OkfImportService } from '../../okf/okf-import.service.js';
import type { McpTool, McpToolContext, McpToolDescriptor } from './schemas.js';

interface BundleFileInput {
  path: string;
  content: string;
}

export interface McpImportOkfInput extends Record<string, unknown> {
  files?: BundleFileInput[];
}

/**
 * Ingest an Open Knowledge Format (OKF v0.1) bundle into Knowledge E3 — the
 * symmetric counterpart to `knowledge.export_okf`, completing the in-product
 * bidirectional bridge. Concepts are matched to existing items by their embedded
 * `e3_id` (then exact title), so re-importing updates rather than duplicates.
 * Writes are attributed to the authenticated caller (or the local system actor).
 */
@Injectable()
export class ImportOkfTool implements McpTool<McpImportOkfInput> {
  readonly descriptor: McpToolDescriptor = {
    name: 'knowledge.import_okf',
    title: 'Import an OKF bundle',
    write: true,
    description:
      'Import an Open Knowledge Format (OKF v0.1) bundle: an array of { path, content } Markdown concept files. Concepts are matched to existing items by their embedded e3_id, then by exact title, so re-importing updates rather than duplicates; unmatched concepts are created. Reserved files (index.md, log.md) are ignored. Returns counts, the new/updated ids, and a conformance report for the input.',
    inputSchema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          description: 'OKF bundle files: each an object with `path` and `content` (Markdown).',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Bundle-relative path, e.g. concepts/orders.md.' },
              content: { type: 'string', description: 'Full concept document (frontmatter + body).' },
            },
            required: ['path', 'content'],
            additionalProperties: false,
          },
        },
      },
      required: ['files'],
      additionalProperties: false,
    },
  };

  constructor(
    private readonly okfImport: OkfImportService,
    private readonly auth: AuthService,
  ) {}

  async call(input: McpImportOkfInput, context: McpToolContext = {}) {
    const files = normalizeFiles(input.files);
    const conformance = validateBundle({ files });

    const actor = mcpActor(context) ?? {
      id: (await this.auth.ensureLocalSystemActor()).id,
      role: 'admin' as const,
    };
    const result = await this.okfImport.importBundleFiles(actor, files);
    return { ...result, conformance };
  }
}

function normalizeFiles(value: unknown): BundleFileInput[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (f): f is BundleFileInput =>
      typeof f === 'object' &&
      f !== null &&
      typeof (f as Record<string, unknown>)['path'] === 'string' &&
      typeof (f as Record<string, unknown>)['content'] === 'string',
  );
}

function mcpActor(context?: McpToolContext): { id: string; role: 'user' | 'admin' } | undefined {
  const user = context?.user;
  if (!user) return undefined;
  return { id: user.id, role: user.role === 'admin' ? 'admin' : 'user' };
}
