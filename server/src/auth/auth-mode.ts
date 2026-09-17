import type { AuthedUser } from './auth.service.js';
import { CREATE_ADMIN_HINT, loadServerConfig } from '../config/server-config.js';

/**
 * The server's own identity for genuine system writes: CLI scripts
 * (`import:okf`, `rebuild:git`, `seed:large`), the inbound source index, and an
 * MCP tool called in-process with no user on its context. It is NEVER the
 * identity of an HTTP request - the guard only ever attaches a signed-in user,
 * a token's owner, or {@link ANONYMOUS_ACTOR} - and it cannot sign in
 * (`AuthService.login` refuses it).
 *
 * The id is kept as-is: existing rows (`owner_id`, audit `actor_id`) carry it.
 */
export const LOCAL_SYSTEM_ACTOR: AuthedUser = {
  id: 'local-system',
  username: 'local-system',
  email: 'local-system@knowledge-e3.local',
  role: 'admin',
};

/**
 * Actor used for unauthenticated visitors when public read access is enabled.
 * It is a NON-admin actor whose id can never own content, so read services
 * (which filter to "published OR owned-by-actor" for non-admins) return only
 * published items. Never used for writes — those still require a real session.
 */
export const ANONYMOUS_ACTOR: AuthedUser = {
  id: '__anonymous__',
  username: 'anonymous',
  email: '',
  role: 'user',
};

/**
 * Refuse to run with authentication turned off.
 *
 * `KNOWLEDGE_E3_AUTH_MODE=disabled` / `auth.mode: disabled` used to make every
 * request the local admin. That mode is gone (the admin UX review §6, answer 5:
 * "at minimum we need an admin password"). Silently ignoring a leftover setting
 * would be the worse failure: the operator believes the instance needs no
 * sign-in, and finds a login wall with no account behind it. So the boot stops
 * with the fix in the message. `session`, or nothing, is fine.
 *
 * Called at boot (`createApp`, before Nest starts) and again from
 * `AuthService.onModuleInit`, so every harness that builds the app - the e2e
 * helpers, CLI scripts on a Nest context - refuses the same way.
 */
export function assertAuthenticationEnabled(): void {
  const env = process.env['KNOWLEDGE_E3_AUTH_MODE']?.trim().toLowerCase();
  if (env === 'disabled') {
    throw new Error(
      `Authentication cannot be disabled (KNOWLEDGE_E3_AUTH_MODE=disabled). ` +
        `Set KNOWLEDGE_E3_AUTH_MODE to session or unset it, and ${CREATE_ADMIN_HINT}.`,
    );
  }
  if (env && env !== 'session') {
    throw new Error(`KNOWLEDGE_E3_AUTH_MODE: expected "session" (got ${JSON.stringify(process.env['KNOWLEDGE_E3_AUTH_MODE'])})`);
  }
  // The file's `auth.mode` is validated while the config loads (server-config.ts
  // `authModeValue`), which throws the matching message.
  loadServerConfig();
}
