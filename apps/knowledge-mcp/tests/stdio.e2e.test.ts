/**
 * End to end over the real bundle: spawn `dist/knowledge-mcp.js`, speak MCP
 * over stdio (`initialize`, `tools/list`, `tools/call`), and check that stdout
 * carries nothing but JSON-RPC while logs go to stderr — and that a server
 * source's token appears in neither stream, even when the server refuses it.
 *
 * Needs the bundle: `pnpm --filter @echozedlabs/knowledge-mcp bundle` first.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CORPUS, json, stubServer, tempDir, writeFiles, type StubServer } from './helpers.js';

const BUNDLE = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'knowledge-mcp.js');
const TOKEN = 'kp_pat_stdio_e2e_TOKEN_5f3a9c1d2e';

describe('knowledge-mcp over stdio (bundled)', () => {
  let tmp: ReturnType<typeof tempDir>;
  let stub: StubServer;
  let child: ChildProcessWithoutNullStreams;
  let stdout = '';
  let stderr = '';
  const pending = new Map<number, (msg: any) => void>();
  let nextId = 1;

  function request(method: string, params?: Record<string, unknown>): Promise<any> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}; stderr: ${stderr}`)), 20_000);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })}\n`);
    });
  }

  beforeAll(async () => {
    if (!existsSync(BUNDLE)) throw new Error(`bundle not found at ${BUNDLE}: run \`pnpm --filter @echozedlabs/knowledge-mcp bundle\` first`);
    tmp = tempDir('knowledge-mcp-stdio-');
    writeFiles(join(tmp.dir, 'handbook'), CORPUS);
    stub = await stubServer((req, res) => {
      if (req.headers.authorization === `Bearer ${TOKEN}`) return json(res, 401, { statusCode: 401, message: 'Token revoked' });
      return json(res, 500, { message: 'unexpected auth header' });
    });
    const config = join(tmp.dir, 'knowledge-mcp.yaml');
    writeFileSync(
      config,
      ['sources:', '  - { id: handbook, type: folder, path: ./handbook }', `  - { id: intranet, type: server, url: "${stub.url}", token_env: KNOWLEDGE_MCP_E2E_TOKEN }`].join('\n'),
    );
    child = spawn(process.execPath, [BUNDLE, '--config', config], {
      env: { ...process.env, KNOWLEDGE_MCP_E2E_TOKEN: TOKEN, KNOWLEDGE_MCP_LOG_LEVEL: 'debug' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    let buffer = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        try {
          const msg = JSON.parse(line);
          if (typeof msg.id === 'number') pending.get(msg.id)?.(msg);
        } catch {
          // asserted below: every stdout line must be JSON
        }
      }
    });
  });

  afterAll(async () => {
    if (child && child.exitCode === null) {
      child.stdin.end();
      await new Promise((resolve) => {
        const t = setTimeout(() => {
          child.kill();
          resolve(undefined);
        }, 5000);
        child.on('exit', () => {
          clearTimeout(t);
          resolve(undefined);
        });
      });
    }
    await stub?.close();
    tmp?.cleanup();
  });

  it('initializes, lists read-only tools, searches per source, and keeps stdout pure JSON-RPC', async () => {
    const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } });
    expect(init.result.serverInfo).toMatchObject({ name: 'knowledge-mcp' });
    expect(init.result.capabilities).toEqual({ tools: {} });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

    const listed = await request('tools/list');
    const names: string[] = listed.result.tools.map((t: any) => t.name);
    expect(names).toContain('knowledge.search');
    expect(names).toContain('knowledge.get_item');
    expect(names.some((n) => /create|update|publish|import|export/.test(n))).toBe(false);

    const search = await request('tools/call', { name: 'knowledge.search', arguments: { q: 'pump' } });
    expect(search.result.isError).toBeUndefined();
    const groups = search.result.structuredContent.sources;
    expect(groups.map((g: any) => g.source)).toEqual(['handbook', 'intranet']);
    expect(groups[0].results.map((h: any) => h.ref)).toEqual(['handbook:item-pump', 'handbook:item-valve']);
    expect(groups[1].error.message).toContain('Source "intranet"');
    expect(groups[1].error.message).toContain('not accepted');

    const item = await request('tools/call', { name: 'knowledge.get_item', arguments: { id: groups[0].results[0].ref } });
    expect(item.result.structuredContent.item.title).toBe('Pump Restart Runbook');

    const refused = await request('tools/call', { name: 'knowledge.search', arguments: { q: 'pump', source: 'intranet' } });
    expect(refused.result.isError).toBe(true);
    expect(refused.result.structuredContent.error.rpc_code).toBe(-32001);

    const sources = await request('tools/call', { name: 'knowledge.list_sources', arguments: {} });
    expect(sources.result.structuredContent.sources[1]).toMatchObject({ id: 'intranet', token_env: 'KNOWLEDGE_MCP_E2E_TOKEN', token_present: true });

    // The stub saw the token as a bearer header — so it was really in play.
    expect(stub.requests.some((r) => r.authorization === `Bearer ${TOKEN}`)).toBe(true);

    // Every stdout line is a JSON-RPC 2.0 message; nothing else was written there.
    const lines = stdout.split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(6);
    for (const line of lines) expect(JSON.parse(line)).toMatchObject({ jsonrpc: '2.0' });

    // Logs went to stderr, and the token is in neither stream (nor its length).
    expect(stderr).toContain('[knowledge-mcp] info: [handbook] indexed 4 item(s)');
    expect(stdout).not.toContain(TOKEN);
    expect(stderr).not.toContain(TOKEN);
    expect(stderr).not.toContain('kp_pat_');
  });

  it('exits non-zero with a clear stderr message for a bad config', async () => {
    const bad = join(tmp.dir, 'bad.yaml');
    writeFileSync(bad, `sources:\n  - { id: s, type: server, url: "https://x.example", token: "${TOKEN}" }\n`);
    const result = await new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
      const p = spawn(process.execPath, [BUNDLE, '--config', bad], { stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      p.stdout.on('data', (c) => (out += c));
      p.stderr.on('data', (c) => (err += c));
      p.on('exit', (code) => resolve({ code, out, err }));
    });
    expect(result.code).toBe(2);
    expect(result.out).toBe('');
    expect(result.err).toContain('never put a token in the config file');
    expect(result.err).not.toContain(TOKEN);
  });
});
