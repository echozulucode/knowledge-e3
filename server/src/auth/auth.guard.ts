import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthService, AuthedUser } from './auth.service.js';
import { ANONYMOUS_ACTOR } from './auth-mode.js';
import { ConfigService } from '../config/config.service.js';
import { ApiTokensService, bearerTokenFrom } from './tokens.service.js';

export const SESSION_COOKIE = 'kp_session';

/** Methods a `read`-scoped personal access token may use over plain HTTP. */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

declare module 'express' {
  interface Request {
    user?: AuthedUser;
    sessionId?: string;
  }
}

// Constructor params are injected with explicit `@Inject` tokens so DI works
// even when the runtime (esbuild, tsx, vitest's default transform) does not
// emit `design:paramtypes` reflection metadata.
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(ApiTokensService) private readonly tokens: ApiTokensService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>('public', [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    const requireAdmin = this.reflector.getAllAndOverride<boolean>('admin', [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    const isPublicRead = this.reflector.getAllAndOverride<boolean>('publicRead', [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    const isPublicRpc = this.reflector.getAllAndOverride<boolean>('publicRpc', [
      ctx.getHandler(),
      ctx.getClass(),
    ]);

    const req = ctx.switchToHttp().getRequest();

    // A request is a session user, a token's owner, the anonymous public-read
    // visitor, or nobody on a @Public route. There is no "authentication off"
    // branch: that mode refuses the boot (auth-mode.ts assertAuthenticationEnabled).
    const cookies = req.cookies ?? {};
    const sid = cookies[SESSION_COOKIE];

    // Resolve a session if one is present. The cookie wins; a bearer personal
    // access token is only consulted when no valid session was found.
    let user = sid ? await this.auth.resolveSession(sid) : null;

    if (!user) {
      const raw = bearerTokenFrom(req.headers?.['authorization']);
      if (raw) {
        user = await this.tokens.authenticate(raw);
        if (!user) {
          if (isPublic) return true;
          throw new UnauthorizedException('Invalid or expired token');
        }
      }
    }

    if (!user) {
      if (isPublic) return true;
      // Anonymous read of public content: allowed only for GET endpoints marked
      // @PublicRead when the instance is in `public` read mode. The anonymous
      // actor is a non-admin sentinel, so services return published items only.
      if (isPublicRead && req.method === 'GET' && (await this.config.getReadAccessMode()) === 'public') {
        req.user = ANONYMOUS_ACTOR;
        req.sessionId = undefined;
        return true;
      }
      // Read-only RPC whose transport requires POST (MCP over Streamable HTTP).
      // Same public-mode condition and same anonymous sentinel; the handler is
      // responsible for refusing writes. See @PublicRpc.
      if (isPublicRpc && req.method === 'POST' && (await this.config.getReadAccessMode()) === 'public') {
        req.user = ANONYMOUS_ACTOR;
        req.sessionId = undefined;
        return true;
      }
      throw new UnauthorizedException(sid ? 'Session expired or invalid' : 'Not signed in');
    }

    req.user = user;
    req.sessionId = user.token ? undefined : sid;

    // A read-scoped token may only read. The MCP transport tunnels everything
    // over POST, so @PublicRpc handlers are exempt here and gate write tools
    // themselves (McpService.callToolByName).
    if (user.token?.scope === 'read' && !READ_METHODS.has(req.method) && !isPublicRpc) {
      throw new ForbiddenException('Token scope is read-only');
    }

    if (requireAdmin && user.role !== 'admin') {
      throw new ForbiddenException('Admin only');
    }

    return true;
  }
}
