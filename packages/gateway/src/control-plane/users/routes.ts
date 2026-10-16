import { userToAdminWire } from './wire.ts';
import { notifyDisabledBestEffort } from '../../dump/registry.ts';
import { type AuthedContext, sessionIdFromContext, userFromContext } from '../../middleware/auth.ts';
import { type CtxWithJson } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import { SEED_ADMIN_USER_ID } from '../../repo/seed-admin.ts';
import type { ApiKey, User } from '../../repo/types.ts';
import { generateApiKeyToken } from '../../shared/api-key-tokens.ts';
import { hashPassword, verifyPassword } from '../../shared/passwords.ts';
import { generateServerSecret } from '../../shared/server-secret.ts';
import type { changeOwnPasswordBody, createUserBody, updateUserBody } from '../schemas.ts';
import { loadKnownUpstreamIds, unknownUpstreamIdsError } from '../shared/upstream-ids.ts';

const parseUserId = (raw: string): number | null => {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : null;
};

const unknownGroupsError = async (ids: readonly number[] | undefined): Promise<string | null> => {
  if (ids === undefined) return null;
  const known = new Set((await getRepo().groups.list()).map(group => group.id));
  const missing = ids.filter(id => !known.has(id));
  return missing.length === 0 ? null : `Unknown group ids: ${missing.join(', ')}`;
};

export const listUsers = async (c: AuthedContext) => {
  const repo = getRepo();
  const [users, knownUpstreamIds] = await Promise.all([repo.users.list(), loadKnownUpstreamIds()]);
  const groupIdsByUser = await repo.groups.listIdsByUserIds(users.map(user => user.id));
  return c.json(users.map(user => userToAdminWire(user, knownUpstreamIds, groupIdsByUser.get(user.id)!)));
};

export const createUser = async (c: CtxWithJson<typeof createUserBody>) => {
  const body = c.req.valid('json');
  const repo = getRepo();
  const groupError = await unknownGroupsError(body.groupIds);
  if (groupError) return c.json({ error: groupError }, 400);

  if (await repo.users.findByUsername(body.username)) {
    return c.json({ error: 'That username is already taken (usernames are case-insensitive).' }, 400);
  }
  const knownUpstreamIds = await loadKnownUpstreamIds();
  if (body.upstreamIds !== undefined) {
    const upstreamErr = unknownUpstreamIdsError(body.upstreamIds, knownUpstreamIds);
    if (upstreamErr) return c.json({ error: upstreamErr }, 400);
  }

  const user = await repo.users.createNewUser({
    username: body.username,
    passwordHash: await hashPassword(body.password),
    isAdmin: body.isAdmin ?? false,
    upstreamIds: body.upstreamIds ?? null,
    createdAt: new Date().toISOString(),
    deletedAt: null,
  });

  const defaultKey: ApiKey = {
    id: crypto.randomUUID(),
    userId: user.id,
    name: 'Default',
    key: generateApiKeyToken(),
    serverSecret: generateServerSecret(),
    createdAt: new Date().toISOString(),
    upstreamIds: null,
    deletedAt: null,
    dumpRetentionSeconds: null,
    openaiResponsesRetentionSeconds: 0,
  };
  await repo.apiKeys.save(defaultKey);
  if (body.groupIds !== undefined) await repo.groups.replaceUserGroups(user.id, body.groupIds);

  return c.json({ user: userToAdminWire(user, knownUpstreamIds, await repo.groups.listIdsByUserId(user.id)) }, 201);
};

export const updateUser = async (c: CtxWithJson<typeof updateUserBody>) => {
  const id = parseUserId(c.req.param('id')!);
  if (id === null) return c.json({ error: 'invalid user id' }, 400);
  const body = c.req.valid('json');
  const actorId = userFromContext(c).id;
  const repo = getRepo();

  const existing = await repo.users.getById(id);
  if (!existing) return c.json({ error: 'user not found' }, 404);
  const groupError = await unknownGroupsError(body.groupIds);
  if (groupError) return c.json({ error: groupError }, 400);

  if (id === SEED_ADMIN_USER_ID && body.isAdmin === false) return c.json({ error: 'user 1 cannot be demoted' }, 400);
  if (id === actorId && body.isAdmin === false) {
    return c.json({ error: 'cannot demote yourself' }, 400);
  }
  if (body.username !== undefined && body.username !== existing.username) {
    const dup = await repo.users.findByUsername(body.username);
    if (dup && dup.id !== id) return c.json({ error: 'username taken' }, 400);
  }
  const knownUpstreamIds = await loadKnownUpstreamIds();
  if (body.upstreamIds !== undefined) {
    const err = unknownUpstreamIdsError(body.upstreamIds, knownUpstreamIds);
    if (err) return c.json({ error: err }, 400);
  }

  const overrides: Partial<User> = {};
  if (body.username !== undefined) overrides.username = body.username;
  if (body.password !== undefined) overrides.passwordHash = await hashPassword(body.password);
  if (body.isAdmin !== undefined) overrides.isAdmin = body.isAdmin;
  if (body.upstreamIds !== undefined) overrides.upstreamIds = body.upstreamIds;
  const next: User = { ...existing, ...overrides };
  await repo.users.save(next, body.groupIds);

  if (body.password !== undefined) {
    const sessionId = sessionIdFromContext(c);
    if (sessionId) await repo.sessions.deleteByUserIdExcept(id, sessionId);
    else await repo.sessions.deleteByUserId(id);
  }

  return c.json(userToAdminWire(next, knownUpstreamIds, await repo.groups.listIdsByUserId(id)));
};

export const deleteUser = async (c: AuthedContext) => {
  const id = parseUserId(c.req.param('id')!);
  if (id === null) return c.json({ error: 'invalid user id' }, 400);
  const actorId = userFromContext(c).id;
  if (id === SEED_ADMIN_USER_ID) return c.json({ error: 'user 1 cannot be deleted' }, 400);
  if (id === actorId) return c.json({ error: 'cannot delete yourself' }, 400);

  const repo = getRepo();

  // The broker close hook cuts any live SSE subscriber but is best-effort;
  // broker availability never blocks the cascade.
  const keys = await repo.apiKeys.listByUserId(id);
  for (const key of keys) {
    await notifyDisabledBestEffort(key.id, 'deleteUser cascade');
  }

  await repo.apiKeys.softDeleteByUserId(id);
  await repo.sessions.deleteByUserId(id);
  await repo.groups.deleteMembershipsByUserId(id);
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
