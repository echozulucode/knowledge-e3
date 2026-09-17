import { describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { GitRevisionMirrorAdapter } from '../src/storage/git-revision-mirror.adapter.js';
import { RoutingRevisionMirror } from '../src/storage/routing-revision-mirror.adapter.js';

describe('Git mirror shutdown', () => {
  it('aborts a stalled direct mirror flush at the shutdown deadline', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const mirror = new GitRevisionMirrorAdapter('unused', {} as never, {
      shutdownFlushTimeoutMs: 5,
    });
    const abort = vi.spyOn(mirror, 'abortShutdown');
    vi.spyOn(mirror, 'flush').mockImplementation(() => new Promise<void>(() => undefined));

    await expect(mirror.onModuleDestroy()).resolves.toBeUndefined();
    expect(abort).toHaveBeenCalledOnce();
    expect(
      (mirror as unknown as { gitAbortController: AbortController }).gitAbortController.signal.aborted,
    ).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('timed out after 5ms'));

    warn.mockRestore();
  });

  it('propagates routed shutdown concurrently and aborts stalled child repos', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const mirror = new RoutingRevisionMirror('unused', {} as never, {
      shutdownFlushTimeoutMs: 5,
    });
    const children = [1, 2].map(() => ({
      onModuleDestroy: vi.fn(() => new Promise<void>(() => undefined)),
      abortShutdown: vi.fn(),
    }));
    const repos = (mirror as unknown as {
      repos: Map<string, (typeof children)[number]>;
    }).repos;
    repos.set('one', children[0]!);
    repos.set('two', children[1]!);

    await expect(mirror.onModuleDestroy()).resolves.toBeUndefined();

    for (const child of children) {
      expect(child.onModuleDestroy).toHaveBeenCalledOnce();
      expect(child.abortShutdown).toHaveBeenCalledOnce();
    }
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('timed out after 5ms'));

    warn.mockRestore();
  });
});
