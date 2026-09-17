import { Injectable } from '@nestjs/common';
import { AuthService } from '../../auth/auth.service.js';
import { OkfImportService } from '../../okf/okf-import.service.js';
import { bundleSummaryLine } from '../../okf/okf-bundle-validation.js';
import type { McpTool, McpToolContext, McpToolDescriptor } from './schemas.js';
import { bundleFilesSchema, normalizeBundleFiles, type BundleFileInput } from './schemas.js';

export interface McpImportOkfInput extends Record<string, unknown> {
  files?: BundleFileInput[];
}

/**
 * Ingest an Open Knowledge Format (OKF v0.2) bundle into Knowledge E3 — the
 * symmetric counterpart to `knowledge.export_okf`, completing the in-product
 * bidirectional bridge. Concepts are matched to existing items by their embedded
 * `e3_id` (then exact title), so re-importing updates rather than duplicates.
 * Writes are attributed to the authenticated caller (or, for an in-process call
 * with no user on the context, the local system actor).
 *
 * This is an import DOOR, so it gates: a bundle whose conformance tier carries a
 * `critical` is refused whole (422, `reason: 'bundle_not_conformant'`) before
 * anything is written. `knowledge.validate_okf_bundle` is the same check without
 * the write, for callers that would rather ask first.
 */
@Injectable()
export class ImportOkfTool implements McpTool<McpImportOkfInput> {
  readonly descriptor: McpToolDescriptor = {
    name: 'knowledge.import_okf',
    title: 'Import an OKF bundle',
    write: true,
    description:
      'Import an Open Knowledge Format (OKF v0.2) bundle: an array of { path, content } Markdown concept files. Concepts are matched to existing items by their embedded e3_id, then by exact title, so re-importing updates rather than duplicates; unmatched concepts are created. Reserved files (index.md, log.md) are ignored. A bundle that is not conformant OKF is rejected as a whole — nothing is written — with reason "bundle_not_conformant" and the full report; failing this instance\'s content policy does NOT block the import, it is recorded as content diagnostics. Use knowledge.validate_okf_bundle to check the same bundle without writing. Returns counts, the new/updated ids, and the three-tier validation report.',
    inputSchema: {
      type: 'object',
      properties: {
        files: bundleFilesSchema,
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
    const files = normalizeBundleFiles(input.files);

    const actor = mcpActor(context) ?? {
      id: (await this.auth.ensureLocalSystemActor()).id,
      role: 'admin' as const,
    };
    // Every concept is written through ContentCommands as this actor; `via: 'mcp'`
    // records the door, as `create_item`/`update_item` do.
    const { validation, ...result } = await this.okfImport.importBundleFiles(actor, files, { gate: true, via: 'mcp' });
    return {
      ...result,
      // `conformance` predates the three-tier report and clients read its
      // `conformant` flag; it is now a projection of the gate's conformance tier
      // rather than a second, independent validation pass over the same bytes.
      conformance: {
        conformant: validation.summary.conformant,
        conceptCount: validation.summary.conceptCount,
        issues: validation.conformance,
      },
      validation,
      summary_line: bundleSummaryLine(validation),
    };
  }
}

function mcpActor(context?: McpToolContext): { id: string; role: 'user' | 'admin'; username?: string } | undefined {
  const user = context?.user;
  if (!user) return undefined;
  return { id: user.id, role: user.role === 'admin' ? 'admin' : 'user', username: user.username };
}
