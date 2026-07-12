import type { AuthedUser } from './auth.service.js';
import { loadServerConfig } from '../config/server-config.js';

export type AuthMode = 'session' | 'disabled';

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

export function getAuthMode(): AuthMode {
  const env = process.env['KNOWLEDGE_E3_AUTH_MODE'];
  if (env === 'disabled') return 'disabled';
  if (env === 'session') return 'session';
  return loadServerConfig().auth.mode;
}
