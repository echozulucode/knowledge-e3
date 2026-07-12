import { Body, Controller, Delete, Get, HttpCode, HttpException, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CurrentUser } from '../auth/auth.decorators.js';
import type { AuthedUser } from '../auth/auth.service.js';
import { McpService } from './mcp.service.js';
import { PagesService } from '../pages/pages.service.js';
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

@Controller('mcp')
export class McpController {
  constructor(
    private readonly mcp: McpService,
    private readonly pages: PagesService,
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
    if (this.rateLimited(res, user)) return;
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
    const server = createMcpServer({ mcp: this.mcp, pages: this.pages }, { user });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  private rateLimited(res: any, user: AuthedUser): boolean {
    const { allowed, retryAfterSeconds } = mcpRateLimiter.hit(user?.id ?? 'anon');
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
  async jsonrpc(@Body() body: Record<string, unknown>, @CurrentUser() user: AuthedUser) {
    const { allowed, retryAfterSeconds } = mcpRateLimiter.hit(user.id);
    if (!allowed) {
      throw new HttpException(
        { message: 'MCP rate limit exceeded', retry_after_seconds: retryAfterSeconds },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return this.mcp.handle(body, { user });
  }
}
