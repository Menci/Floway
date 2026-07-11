import { userToRawWire } from './wire.ts';
import { getDumpStore, notifyDisabledBestEffort } from '../../dump/registry.ts';
import { type AuthedContext, sessionIdFromContext, userFromContext } from '../../middleware/auth.ts';
import { type CtxWithJson } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import type { ApiKey, User } from '../../repo/types.ts';
import { generateApiKeyToken } from '../../shared/api-key-tokens.ts';
import { hashPassword, verifyPassword } from '../../shared/passwords.ts';
import type { changeOwnPasswordBody, createUserBody, updateUserBody } from '../schemas.ts';

const validateUpstreamIdsExist = async (ids: readonly string[] | null): Promise<string | null> => {
  if (ids === null) return null;
  const upstreams = await getRepo().upstreams.list();
  const known = new Set(upstreams.map(u => u.id));
  const unknown = ids.filter(id => !known.has(id));
  return unknown.length ? `Unknown upstream(s): ${unknown.join(', ')}` : null;
};

const parseUserId = (raw: string): number | null => {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : null;
};

export const listUsers = async (c: AuthedContext) => {
  const users = await getRepo().users.list();
  return c.json(users.map(userToRawWire));
};

export const createUser = async (c: CtxWithJson<typeof createUserBody>) => {
  const body = c.req.valid('json');
  const repo = getRepo();

  if (await repo.users.findByUsername(body.username)) {
    return c.json({ error: 'That username is already taken (usernames are case-insensitive).' }, 400);
  }
  if (body.upstreamIds !== undefined) {
    const upstreamErr = await validateUpstreamIdsExist(body.upstreamIds);
    if (upstreamErr) return c.json({ error: upstreamErr }, 400);
  }

  const user = await repo.users.createNewUser({
    username: body.username,
    passwordHash: await hashPassword(body.password),
    isAdmin: body.isAdmin ?? false,
    upstreamIds: body.upstreamIds ?? null,
    canViewGlobalTelemetry: body.canViewGlobalTelemetry ?? false,
    createdAt: new Date().toISOString(),
    deletedAt: null,
  });

  const defaultKey: ApiKey = {
    id: crypto.randomUUID(),
    userId: user.id,
    name: 'Default',
    key: generateApiKeyToken(),
    createdAt: new Date().toISOString(),
    upstreamIds: null,
    deletedAt: null,
    dumpRetentionSeconds: null,
  };
  await repo.apiKeys.save(defaultKey);

  return c.json({ user: userToRawWire(user) }, 201);
};

export const updateUser = async (c: CtxWithJson<typeof updateUserBody>) => {
  const id = parseUserId(c.req.param('id')!);
  if (id === null) return c.json({ error: 'invalid user id' }, 400);
  const body = c.req.valid('json');
  const actorId = userFromContext(c).id;
  const repo = getRepo();

  const existing = await repo.users.getById(id);
  if (!existing) return c.json({ error: 'user not found' }, 404);

  if (id === 1 && body.isAdmin === false) return c.json({ error: 'user 1 cannot be demoted' }, 400);
  if (id === actorId && body.isAdmin === false) {
    return c.json({ error: 'cannot demote yourself' }, 400);
  }
  if (body.username !== undefined && body.username !== existing.username) {
    const dup = await repo.users.findByUsername(body.username);
    if (dup && dup.id !== id) return c.json({ error: 'username taken' }, 400);
  }
  if (body.upstreamIds !== undefined) {
    const err = await validateUpstreamIdsExist(body.upstreamIds);
    if (err) return c.json({ error: err }, 400);
  }

  const overrides: Partial<User> = {};
  if (body.username !== undefined) overrides.username = body.username;
  if (body.password !== undefined) overrides.passwordHash = await hashPassword(body.password);
  if (body.isAdmin !== undefined) overrides.isAdmin = body.isAdmin;
  if (body.upstreamIds !== undefined) overrides.upstreamIds = body.upstreamIds;
  if (body.canViewGlobalTelemetry !== undefined) overrides.canViewGlobalTelemetry = body.canViewGlobalTelemetry;
  const next: User = { ...existing, ...overrides };
  await repo.users.save(next);

  if (body.password !== undefined) {
    const sessionId = sessionIdFromContext(c);
    if (sessionId) await repo.sessions.deleteByUserIdExcept(id, sessionId);
    else await repo.sessions.deleteByUserId(id);
  }

  return c.json(userToRawWire(next));
};

export const deleteUser = async (c: AuthedContext) => {
  const id = parseUserId(c.req.param('id')!);
  if (id === null) return c.json({ error: 'invalid user id' }, 400);
  const actorId = userFromContext(c).id;
  if (id === 1) return c.json({ error: 'user 1 cannot be deleted' }, 400);
  if (id === actorId) return c.json({ error: 'cannot delete yourself' }, 400);

  const repo = getRepo();

  // Purge each owned key's dumps before the cascade so a purge failure leaves
  // the user (and their keys) intact and retriable. We iterate live keys
  // because soft-deleted keys were already purged at their own delete time.
  // The broker close hook cuts any live SSE subscriber but is best-effort —
  // broker availability never blocks the cascade.
  const keys = await repo.apiKeys.listByUserId(id);
  for (const key of keys) {
    await getDumpStore().purgeAll(key.id);
    await notifyDisabledBestEffort(key.id, 'deleteUser cascade');
  }

  await repo.apiKeys.softDeleteByUserId(id);
  await repo.sessions.deleteByUserId(id);
  const ok = await repo.users.softDelete(id);
  if (!ok) return c.json({ error: 'user not found' }, 404);
  return c.json({ ok: true });
};

export const changeOwnPassword = async (c: CtxWithJson<typeof changeOwnPasswordBody>) => {
  const sessionId = sessionIdFromContext(c);
  if (!sessionId) {
    return c.json({ error: 'Self-service password change requires a logged-in dashboard session' }, 401);
  }
  const user = userFromContext(c);
  const { currentPassword, newPassword } = c.req.valid('json');
  const repo = getRepo();

  // 400, not 401: these are domain validation errors on the request payload,
  // not authentication failures. The dashboard's auth client treats 401 as
  // "session expired" and silently signs the user out, which is wrong here —
  // the actor's session is fine, they just typed the wrong current password.
  if (user.passwordHash === null) {
    return c.json({ error: 'This account has no password set; ask an admin to reset it.' }, 400);
  }
  if (!(await verifyPassword(currentPassword, user.passwordHash))) {
    return c.json({ error: 'Current password is incorrect' }, 400);
  }

  await repo.users.save({ ...user, passwordHash: await hashPassword(newPassword) });
  await repo.sessions.deleteByUserIdExcept(user.id, sessionId);
  return c.json({ ok: true });
};
