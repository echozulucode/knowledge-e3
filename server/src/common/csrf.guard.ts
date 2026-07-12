import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Origin-verification CSRF defense for cookie-authenticated, state-changing
 * requests. This sits on top of `SameSite=Lax` session cookies (which already
 * block most cross-site cases) as defense-in-depth.
 *
 * Policy (mutating methods only):
 *  - No `Origin` header → allow. Server-to-server clients (MCP), same-origin
 *    navigations, and the test harness don't send one, and a forged cross-site
 *    request that *did* carry our cookie would have an Origin we'd then check.
 *  - Origin in the configured allowlist (`KNOWLEDGE_E3_ALLOWED_ORIGINS`) → allow.
 *  - Origin host == request Host (same-origin deployment) → allow.
 *  - Any localhost/127.0.0.1 origin in non-production (the Vite dev proxy uses a
 *    different port than the API) → allow.
 *  - Otherwise → 403.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  private readonly allowlist: string[];
  private readonly isProd: boolean;

  constructor() {
    this.allowlist = (process.env['KNOWLEDGE_E3_ALLOWED_ORIGINS'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    this.isProd = process.env['NODE_ENV'] === 'production';
  }

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    if (!MUTATING_METHODS.has(req.method)) return true;

    const origin = this.headerValue(req.headers['origin']);
    if (!origin) return true;

    if (this.isAllowedOrigin(origin, this.headerValue(req.headers['host']))) return true;
    throw new ForbiddenException('Cross-origin request blocked');
  }

  private isAllowedOrigin(origin: string, host: string | undefined): boolean {
    if (this.allowlist.includes(origin)) return true;
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      return false;
    }
    if (host && url.host === host) return true;
    if (!this.isProd && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) return true;
    return false;
  }

  private headerValue(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
  }
}
