import { createHmac, timingSafeEqual } from 'node:crypto';
import { Controller, ForbiddenException, HttpCode, NotFoundException, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../auth/auth.decorators.js';
import { SourceRegistryService } from './source-registry.service.js';
import { SyncService } from './sync.service.js';

/**
 * Host push notifications (plan §8.1 "schedule or webhook"). Public route,
 * authenticated by the secret the source's `webhook_secret_env` names: either
 * GitHub's `X-Hub-Signature-256` (HMAC-SHA256 of the raw body) or a plain
 * `X-Webhook-Secret` header. A valid call schedules a sync cycle and returns
 * at once. The body arrives raw (see `configureApp`) so the HMAC is byte-exact.
 */
@Controller('sync/webhook')
export class WebhookController {
  constructor(
    private readonly registry: SourceRegistryService,
    private readonly sync: SyncService,
  ) {}

  @Public()
  @Post(':sourceId')
  @HttpCode(202)
  async receive(@Param('sourceId') sourceId: string, @Req() req: Request) {
    const source = await this.registry.get(sourceId);
    if (!source?.webhook_secret_env) throw new NotFoundException('No webhook is configured for this source');
    const secret = process.env[source.webhook_secret_env];
    if (!secret) throw new ForbiddenException('Webhook secret is not set on the server');

    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {}));
    if (!verify(req, body, secret)) throw new ForbiddenException('Webhook signature mismatch');

    void this.sync.runNow(sourceId).catch(() => undefined);
    return { accepted: true, source: sourceId };
  }
}

function verify(req: Request, body: Buffer, secret: string): boolean {
  const signature = header(req, 'x-hub-signature-256');
  if (signature) {
    const expected = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    return safeEqual(signature, expected);
  }
  const plain = header(req, 'x-webhook-secret');
  return plain !== undefined && safeEqual(plain, secret);
}

function header(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
