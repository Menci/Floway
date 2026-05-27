// Auth routes — ADMIN_KEY validation plus identity/logout helpers.
// No sessions, no cookies. All authenticated requests carry a key.

import type { Context } from 'hono';

import { type CtxWithJson } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import { getEnv } from '../../runtime/env.ts';
import type { authLoginBody } from '../schemas.ts';

/** POST /auth/login — validate ADMIN_KEY or API key. */
export const authLogin = async (c: CtxWithJson<typeof authLoginBody>) => {
  const body = c.req.valid('json');
  const adminKey = getEnv('ADMIN_KEY');

  if (adminKey && body.key === adminKey) {
    return c.json({ ok: true, isAdmin: true });
  }

  const key = await getRepo().apiKeys.findByRawKey(body.key);
  if (key) {
    return c.json({
      ok: true,
      isAdmin: false,
      keyId: key.id,
      keyName: key.name,
      keyHint: body.key.slice(-4),
    });
  }

  return c.json({ error: 'Invalid key' }, 401);
};

/** POST /auth/logout — no-op; clients clear local storage */
export const authLogout = (c: Context) => c.json({ ok: true });

/** GET /auth/me — current auth identity only, not connected upstream state */
export const authMe = (c: Context) => {
  const isAdmin = c.get('isAdmin') === true;
  const apiKeyId = c.get('apiKeyId') as string | undefined;
  return c.json({
    authenticated: true,
    isAdmin,
    ...(apiKeyId ? { keyId: apiKeyId } : {}),
  });
};
