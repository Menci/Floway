import type { Context, Next } from 'hono';

import { getRepo } from '../repo/index.ts';
import type { ApiKey, User } from '../repo/types.ts';
import { timingSafeEqual } from '../shared/passwords.ts';
import { getEnv } from '@floway-dev/platform';

const PUBLIC_PATHS = new Set(['/api/health', '/favicon.ico']);
const AUTH_VALIDATE_PATHS = new Set(['/auth/login']);

// The three slots auth middleware stamps on every authenticated request. All
// optional because public / login routes carry none; handlers that require
// one assert via the typed accessors below rather than reading c.get raw.
// Hono's `Variables` generic makes c.set / c.get type-checked at the key
// level once the app is built as `new Hono<{ Variables: AuthVars }>()`.
export interface AuthVars {
  apiKey: ApiKey | undefined;
  user: User | undefined;
  sessionId: string | undefined;
}

// The optional `Path` generic threads a route's literal path through so
// `c.req.param('id')` narrows to `string` on routes that declare `:id`.
// Default to `string` for handlers that don't read a path param.
export type AuthedContext<Path extends string = string> = Context<{ Variables: AuthVars }, Path>;

export const authMiddleware = async (c: AuthedContext, next: Next) => {
  const path = c.req.path;
  if (PUBLIC_PATHS.has(path) && c.req.method === 'GET') return await next();
  if (AUTH_VALIDATE_PATHS.has(path) && c.req.method === 'POST') return await next();

  // Browsers cannot attach custom headers to EventSource, so the dump SSE
  // stream — the only browser-driven SSE endpoint — accepts the session
  // token as a query string instead. Path/method are pinned to the single
  // endpoint that needs it to keep the URL-leak surface narrow.
  const isDumpStreamGet = c.req.method === 'GET'
    && /^\/api\/dump\/keys\/[^/]+\/stream$/.test(path);
  const sessionToken = c.req.header('x-floway-session')
    ?? (isDumpStreamGet ? c.req.query('session') : undefined);
  if (sessionToken) {
    if (!(path.startsWith('/api/') || path.startsWith('/auth/'))) {
      return c.json({ error: 'Session tokens are only valid on dashboard routes; data-plane requests must use an API key.' }, 401);
    }
    const session = await getRepo().sessions.getByIdAndTouch(sessionToken);
    if (!session) return c.json({ error: 'Invalid session' }, 401);
    const user = await getRepo().users.getById(session.userId);
    if (!user) {
      await getRepo().sessions.deleteById(sessionToken);
      return c.json({ error: 'Invalid session' }, 401);
    }
    c.set('user', user);
    c.set('sessionId', sessionToken);
    return await next();
  }

  const rawKey = extractApiKey(c);
  if (!rawKey) return c.json({ error: 'Unauthorized' }, 401);

  const adminKey = getEnv('ADMIN_KEY');
  if (adminKey) {
    const utf8 = new TextEncoder();
    if (timingSafeEqual(utf8.encode(rawKey), utf8.encode(adminKey))) {
      return c.json({ error: 'ADMIN_KEY is only valid via POST /auth/login (leave username blank).' }, 401);
    }
  }

  const apiKey = await getRepo().apiKeys.findByRawKey(rawKey);
  if (!apiKey) return c.json({ error: 'Unauthorized' }, 401);
  const user = await getRepo().users.getById(apiKey.userId);
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  c.set('apiKey', apiKey);
  c.set('user', user);
  await next();
};

const extractApiKey = (c: Context): string | null => {
  const url = new URL(c.req.url);
  return url.searchParams.get('key')
    ?? c.req.header('x-api-key')
    ?? c.req.header('x-goog-api-key')
    ?? c.req.header('authorization')?.replace(/^Bearer\s+/i, '')
    ?? null;
};

// Authenticated-route accessors. Each throws when the requested slot is
// unset so misuse surfaces immediately instead of reading silently as
// undefined. Use these instead of raw c.get so every reader goes through
// the same assertion (and the bare-Context handler signatures don't have to
// thread AuthVars typing manually).
export const apiKeyFromContext = (c: AuthedContext): ApiKey => {
  const apiKey = c.get('apiKey');
  if (!apiKey) throw new Error('apiKeyFromContext: no API key on this request; this route must be reached via API-key auth');
  return apiKey;
};

export const userFromContext = (c: AuthedContext): User => {
  const user = c.get('user');
  if (!user) throw new Error('userFromContext: no authenticated user on this request');
  return user;
};

export const sessionIdFromContext = (c: AuthedContext): string | undefined => c.get('sessionId');

// Pure derivation off the User row — admins inherit global-telemetry
// access, regular users carry the explicit flag. Lives next to the auth
// helpers so the rule has one home.
export const canViewGlobalTelemetry = (user: User): boolean => user.isAdmin || user.canViewGlobalTelemetry;

// Per-user upstream cap. null = unrestricted at the user level.
export const userUpstreamIdsFromContext = (c: AuthedContext): readonly string[] | null =>
  c.get('user')?.upstreamIds ?? null;

// Effective upstream whitelist for this request: intersect the per-user cap
// with the per-key whitelist. null = unrestricted. Session-only requests
// resolve to the per-user cap alone (apiKey is absent). Data-plane reads
// this to constrain provider/candidate selection.
export const effectiveUpstreamIdsFromContext = (c: AuthedContext): readonly string[] | null => {
  const userIds = c.get('user')?.upstreamIds ?? null;
  const keyIds = c.get('apiKey')?.upstreamIds ?? null;
  if (userIds === null && keyIds === null) return null;
  if (userIds === null) return keyIds;
  if (keyIds === null) return userIds;
  const userSet = new Set(userIds);
  return keyIds.filter(id => userSet.has(id));
};
