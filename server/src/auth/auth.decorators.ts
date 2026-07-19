import { SetMetadata, createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AuthedUser } from './auth.service.js';

export const Public = () => SetMetadata('public', true);
export const AdminOnly = () => SetMetadata('admin', true);
/** Marks a read (GET) endpoint as viewable by anonymous visitors when the
 * instance's read-access mode is `public`. Writes must never use this. */
export const PublicRead = () => SetMetadata('publicRead', true);

/**
 * Marks a POST endpoint that carries a READ-ONLY RPC protocol whose transport
 * requires POST, and which may therefore serve anonymous visitors when the
 * instance's read-access mode is `public`.
 *
 * This exists solely for MCP: the Streamable HTTP transport tunnels reads over
 * POST, so @PublicRead (deliberately GET-only) can never apply. It is a
 * narrower escape hatch, not a general "allow anonymous POST":
 *  - the handler MUST enforce read-only semantics itself for anonymous callers
 *    (see McpService.callToolByName — hiding write tools from tools/list is not
 *    enough on its own), and
 *  - the anonymous actor stays a non-admin sentinel, so the normal
 *    "published OR owned-by-actor" filters still apply to everything it reads.
 */
export const PublicRpc = () => SetMetadata('publicRpc', true);

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthedUser | undefined => {
    const req = ctx.switchToHttp().getRequest();
    return req.user;
  },
);
