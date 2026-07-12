import { type AuthedContext, sessionIdFromContext, userFromContext } from '../../middleware/auth.ts';
import { type CtxWithJson } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import type { User } from '../../repo/types.ts';
import { isProductionRequest } from '../../shared/is-production-request.ts';
import { dummyPasswordHash, timingSafeEqual, verifyPassword } from '../../shared/passwords.ts';
import type { authLoginBody } from '../schemas.ts';
import { userToEffectiveWire } from '../users/wire.ts';
import { getEnv } from '@floway-dev/platform';

const resolveLoginUser = async (c: CtxWithJson<typeof authLoginBody>): Promise<User | null> => {
  const { username, password } = c.req.valid('json');
  const repo = getRepo();

  if (username === '') {
    const adminKey = getEnv('ADMIN_KEY');
    if (adminKey) {
      const utf8 = new TextEncoder();
      if (!timingSafeEqual(utf8.encode(password), utf8.encode(adminKey))) return null;
    } else if (isProductionRequest(c)) {
      // Empty ADMIN_KEY grants zero-config passwordless admin login on
      // dev instances (no .dev.vars needed) but would leave a production
      // deployment world-open. Refuse when the request signals prod —
      // per-runtime detection lives in isProductionRequest.
      return null;
    }
    const user = await repo.users.getById(1);
    if (!user) throw new Error('ADMIN_KEY login: seed admin (user 1) is missing');
    return user;
  }

  const user = await repo.users.findByUsername(username);
  // Burn equivalent PBKDF2 work on the no-user / no-hash branch so request
  // latency does not distinguish a real account from a missing one.
  if (!user?.passwordHash) {
    await verifyPassword(password, await dummyPasswordHash());
    return null;
  }
  if (!(await verifyPassword(password, user.passwordHash))) return null;
  return user;
};

export const authLogin = async (c: CtxWithJson<typeof authLoginBody>) => {
  const user = await resolveLoginUser(c);
  if (!user) return c.json({ error: 'Invalid username or password' }, 401);
  const session = await getRepo().sessions.create(user.id);
  return c.json({ token: session.id, user: userToEffectiveWire(user) });
};

export const authLogout = async (c: AuthedContext) => {
  const sessionId = sessionIdFromContext(c);
  if (sessionId) await getRepo().sessions.deleteById(sessionId);
  return c.json({ ok: true });
};

export const authMe = async (c: AuthedContext) => {
  const user = userFromContext(c);
  const sessionId = sessionIdFromContext(c);
  const apiKey = c.get('apiKey');
  return c.json({
    user: userToEffectiveWire(user),
    viaApiKey: !sessionId,
    apiKey: apiKey ? { id: apiKey.id, name: apiKey.name } : null,
  });
};
