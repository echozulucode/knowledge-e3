import { Body, Controller, Delete, Get, HttpCode, HttpException, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CurrentUser, PublicRpc } from '../auth/auth.decorators.js';
import { ANONYMOUS_ACTOR } from '../auth/auth-mode.js';
import type { AuthedUser } from '../auth/auth.service.js';
import { McpService } from './mcp.service.js';
import { PagesService } from '../pages/pages.service.js';
import { KnowledgeQueryService } from '../query/knowledge-query.service.js';
import { SpacesService } from '../taxonomy/spaces.service.js';
import { createMcpServer } from './mcp-server.factory.js';
import { SlidingWindowRateLimiter } from '../common/rate-limiter.js';
import { loadServerConfig } from '../config/server-config.js';

// Per-user request budget for the MCP surface. tools/call fans out to
// search/create scans, so a client must not be able to hammer it unbounded.
// 120 requests/min ≈ 2/s sustained — generous for an agent loop.
const MCP_RATE_LIMIT = Number(
  process.env['KNOWLEDGE_E3_MCP_RATE_LIMIT'] ?? loadServerConfig().mcp.rateLimit,
);
const mcpRateLimiter = new SlidingWindowRateLimiter(MCP_RATE_LIMIT, 60 * 1000);

/**
 * @PublicRpc: MCP tunnels reads over POST, so @PublicRead (GET-only) can never
 * apply. On a `public` instance an anonymous visitor therefore gets the same
 * read-only view here that they already get over HTTP — write tools are hidden
 * from tools/list AND refused in McpService.callToolByName. When the instance is
 * `authenticated`, this decorator does nothing and a session is required.
 */
@PublicRpc()
@Controller('mcp')
export class McpController {
  constructor(
    private readonly mcp: McpService,
    private readonly pages: PagesService,
    private readonly query: KnowledgeQueryService,
    private readonly spaces: SpacesService,
  ) {}

  /**
   * Spec-compliant MCP endpoint over the Streamable HTTP transport (stateless):
   * a fresh Server + transport per request. The SDK owns the `initialize`
   * lifecycle, capability negotiation, and JSON-RPC framing. GET/DELETE are
   * accepted so the transport answers them per spec (no standalone SSE in
   * stateless mode).
   */
  @Post()
  async streamPost(@Req() req: any, @Res() res: any, @CurrentUser() user: AuthedUser) {
    if (this.rateLimited(res, user, req)) return;
    await this.dispatch(req, res, user, req.body);
  }

  @Get()
  async streamGet(@Req() req: any, @Res() res: any, @CurrentUser() user: AuthedUser) {
    await this.dispatch(req, res, user);
  }

  @Delete()
  async streamDelete(@Req() req: any, @Res() res: any, @CurrentUser() user: AuthedUser) {
    await this.dispatch(req, res, user);
  }

  private async dispatch(req: any, res: any, user: AuthedUser, body?: unknown) {
    const server = createMcpServer({ mcp: this.mcp, pages: this.pages, query: this.query, spaces: this.spaces }, { user });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  /**
   * Per-caller request budget. Signed-in callers are keyed by user id; anonymous
   * visitors on a public instance are keyed by IP, because they all share the
   * single ANONYMOUS_ACTOR id and would otherwise contend for one bucket — one
   * client could then rate-limit every other reader off the instance.
   */
  private rateLimitKey(user: AuthedUser, req: any): string {
    if (!user) return `ip:${clientIp(req)}`;
    if (user.id === ANONYMOUS_ACTOR.id) return `ip:${clientIp(req)}`;
    return `user:${user.id}`;
  }

  private rateLimited(res: any, user: AuthedUser, req: any): boolean {
    const { allowed, retryAfterSeconds } = mcpRateLimiter.hit(this.rateLimitKey(user, req));
    if (!allowed) {
      res.status(429).json({ message: 'MCP rate limit exceeded', retry_after_seconds: retryAfterSeconds });
      return true;
    }
    return false;
  }

  /**
   * Legacy bespoke JSON-RPC surface (tools/list + tools/call only). Retained for
   * backward compatibility; new clients should use the spec-compliant endpoint
   * above. Not a full MCP lifecycle (no `initialize`).
   */
  @Post('jsonrpc')
  @HttpCode(200)
  async jsonrpc(@Body() body: Record<string, unknown>, @Req() req: any, @CurrentUser() user: AuthedUser) {
    const { allowed, retryAfterSeconds } = mcpRateLimiter.hit(this.rateLimitKey(user, req));
    if (!allowed) {
      throw new HttpException(
        { message: 'MCP rate limit exceeded', retry_after_seconds: retryAfterSeconds },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return this.mcp.handle(body, { user });
  }
}

/**
 * Client IP for rate-limit bucketing: Express's `req.ip`, which honours the
 * server's `trust proxy` setting (`server.trustProxy` / `TRUST_PROXY`).
 *
 * This used to read `X-Forwarded-For` itself. That header is client-supplied, so
 * any anonymous caller could rotate their own bucket per request. Behind an
 * ingress the operator now trusts exactly the proxy hop instead, and `req.ip`
 * is the real client; with no proxy configured it is the socket address.
 * This is a fairness control, not an authentication one.
 */
function clientIp(req: any): string {
  return req?.ip || req?.socket?.remoteAddress || 'unknown';
}
