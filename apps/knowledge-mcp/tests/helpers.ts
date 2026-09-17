import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createLogger, Redactor, type Logger } from '../src/log.js';

export function tempDir(prefix = 'knowledge-mcp-test-'): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    const abs = join(root, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
}

export function captureLogger(redactor = new Redactor()): { logger: Logger; lines: string[]; redactor: Redactor } {
  const lines: string[] = [];
  return { logger: createLogger({ write: (l) => lines.push(l), level: 'debug', redactor }), lines, redactor };
}

export interface StubServer {
  url: string;
  requests: { method: string; url: string; authorization: string | undefined }[];
  close: () => Promise<void>;
}

export async function stubServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<StubServer> {
  const requests: StubServer['requests'] = [];
  const server: Server = createServer((req, res) => {
    requests.push({ method: req.method ?? '', url: req.url ?? '', authorization: req.headers.authorization });
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** A small OKF-style corpus used by several suites. */
export const CORPUS: Record<string, string> = {
  'ops/concepts/pump-restart.md': [
    '---',
    'e3_id: item-pump',
    'title: Pump Restart Runbook',
    'type: Runbook',
    'description: How to restart the modbus pump controller.',
    'tags: [pumps, modbus]',
    'categories: [runbooks]',
    'groups: [Plant Operators]',
    'authors: [Ada Lovelace]',
    'timestamp: 2026-09-01T10:00:00.000Z',
    'aliases: [MBPC]',
    '---',
    '',
    'Stop the line, then restart the **modbus** pump controller from the panel.',
    'See [[Valve Checklist]] before restarting.',
    '',
  ].join('\n'),
  'ops/concepts/valve-checklist.md': [
    '---',
    'e3_id: item-valve',
    'title: Valve Checklist',
    'type: Checklist',
    'tags: [valves]',
    'categories: [checklists]',
    'author: Grace Hopper',
    'timestamp: 2025-01-15T09:00:00.000Z',
    '---',
    '',
    'Check every valve. The pump must be stopped first.',
    '',
  ].join('\n'),
  'ops/concepts/draft-idea.md': [
    '---',
    'e3_id: item-draft',
    'title: Draft Pump Idea',
    'status: draft',
    'type: Concept',
    'timestamp: 2026-09-10T09:00:00.000Z',
    '---',
    '',
    'An unfinished pump idea.',
    '',
  ].join('\n'),
  'platform/concepts/deploy.md': [
    '---',
    'e3_id: item-deploy',
    'title: Deploy Guide',
    'type: Runbook',
    'tags: [deploy]',
    'timestamp: 2026-08-20T09:00:00.000Z',
    'verified:',
    '  by: human:ada',
    '  at: 2026-08-21T00:00:00.000Z',
    '---',
    '',
    'Deploy the platform with the pipeline. Legacy steps are gone.',
    '',
  ].join('\n'),
  'ops/index.md': ['---', 'presentation: docs', 'start_here: pump-restart', '---', '', '# Ops', '', 'Operations handbook.', ''].join('\n'),
};
