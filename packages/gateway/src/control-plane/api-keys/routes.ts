import { notifyDisabledBestEffort } from '../../dump/registry.ts';
import { type AuthedContext, userFromContext, userUpstreamIdsFromContext } from '../../middleware/auth.ts';
import { type CtxWithJson } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import type { ApiKey } from '../../repo/types.ts';
import { CUSTOM_API_KEY_MAX_LENGTH, generateApiKeyToken, type KeySource } from '../../shared/api-key-tokens.ts';
import { generateServerSecret } from '../../shared/server-secret.ts';
import type { createKeyBody, rotateKeyBody, updateKeyBody } from '../schemas.ts';
import { ownedKeyForUser } from '../shared/owned-key.ts';
import { loadKnownUpstreamIds, pruneUnreachableUpstreamIds, reachableUpstreamIds, unknownUpstreamIdsError } from '../shared/upstream-ids.ts';

const GENERATED_KEY_RETRIES = 5;

type KeyWriteError = {
  ok: false;
  status: 400 | 409 | 500;
  error: string;
};

type KeyWriteResult = { ok: true; key: ApiKey } | KeyWriteError;

const keyWriteError = (status: KeyWriteError['status'], error: string): KeyWriteError => ({ ok: false, status, error });

// The set is what this key's owner can reach, not the whole catalog: a grant
// their cap no longer covers routes nothing, so serving it would put a row in
// the dashboard that resolves to no upstream.
const apiKeyToJson = (key: ApiKey, reachable: ReadonlySet<string>) => ({
  id: key.id,
  name: key.name,
  key: key.key,
  created_at: key.createdAt,
  last_used_at: key.lastUsedAt ?? null,
  upstream_ids: pruneUnreachableUpstreamIds(key.upstreamIds, reachable),
  dump_retention_seconds: key.dumpRetentionSeconds,
  responses_retention_seconds: key.responsesRetentionSeconds,
});

const normalizeCustomKey = (value: unknown): { ok: true; key: string } | KeyWriteError => {
  if (typeof value !== 'string') {
    return keyWriteError(400, 'custom_key is required when key_source is custom');
  }
  const trimmed = value.trim();
  if (!trimmed) return keyWriteError(400, 'custom_key is required when key_source is custom');
  if (trimmed.length > CUSTOM_API_KEY_MAX_LENGTH) {
    return keyWriteError(400, `custom_key must be at most ${CUSTOM_API_KEY_MAX_LENGTH} characters`);
  }
  return { ok: true, key: trimmed };
};

const duplicateKeyError = (): KeyWriteError => keyWriteError(409, 'An API key with that raw key already exists.');

const isRawKeyUniqueConstraint = (error: unknown): boolean =>
  /UNIQUE constraint failed: api_keys\.key(?:\b|$)/i.test(error instanceof Error ? error.message : String(error));

const findAnyByRawKey = async (rawKey: string): Promise<ApiKey | null> =>
  (await getRepo().apiKeys.listIncludingDeleted()).find(key => key.key === rawKey) ?? null;

const saveGeneratedKey = async (template: Omit<ApiKey, 'key'>): Promise<KeyWriteResult> => {
  for (let i = 0; i < GENERATED_KEY_RETRIES; i++) {
    const key: ApiKey = { ...template, key: generateApiKeyToken() };
    if (await findAnyByRawKey(key.key)) continue;
    try {
      await getRepo().apiKeys.save(key);
      return { ok: true, key };
    } catch (error) {
      if (isRawKeyUniqueConstraint(error)) continue;
      throw error;
    }
  }
  return keyWriteError(500, 'Could not allocate a unique API key; retry the request.');
};

const saveCustomKey = async (template: Omit<ApiKey, 'key'>, rawKey: string): Promise<KeyWriteResult> => {
  const existing = await findAnyByRawKey(rawKey);
  if (existing && existing.id !== template.id) return duplicateKeyError();
  const key: ApiKey = { ...template, key: rawKey };
  try {
    await getRepo().apiKeys.save(key);
    return { ok: true, key };
  } catch (error) {
    if (isRawKeyUniqueConstraint(error)) return duplicateKeyError();
    throw error;
  }
};

// Reject custom_key on a non-custom source so a caller cannot smuggle a
// bring-your-own key past the picker they explicitly opted out of.
const writeKeyForRequest = async (
  template: Omit<ApiKey, 'key'>,
  body: { key_source?: KeySource; custom_key?: string },
): Promise<KeyWriteResult> => {
  const source = body.key_source ?? 'generate';
  if (source !== 'custom' && body.custom_key !== undefined) {
    return keyWriteError(400, 'custom_key is only valid when key_source is custom');
  }
  if (source === 'custom') {
    const customKey = normalizeCustomKey(body.custom_key);
    if (!customKey.ok) return customKey;
    return await saveCustomKey(template, customKey.key);
  }
  return await saveGeneratedKey(template);
};

const validateUpstreamIdsAgainstUserCap = (
  c: AuthedContext,
  proposed: readonly string[] | null,
  knownUpstreamIds: ReadonlySet<string>,
): string | null => {
  const unknownUpstreamError = unknownUpstreamIdsError(proposed, knownUpstreamIds);
  if (unknownUpstreamError !== null) return unknownUpstreamError;
  if (proposed === null) return null;

  const userCap = userUpstreamIdsFromContext(c);
  if (userCap === null) return null;
  const userSet = new Set(userCap);
  const blocked = proposed.filter(id => !userSet.has(id));
  return blocked.length
    ? `Some selected upstreams aren't available to your account: ${blocked.join(', ')}`
    : null;
};

export const listKeys = async (c: AuthedContext) => {
  const userId = userFromContext(c).id;
  const [keys, knownUpstreamIds] = await Promise.all([getRepo().apiKeys.listByUserId(userId), loadKnownUpstreamIds()]);
  const reachable = reachableUpstreamIds(knownUpstreamIds, userUpstreamIdsFromContext(c));
  return c.json(keys.map(key => apiKeyToJson(key, reachable)));
};

export const createKey = async (c: CtxWithJson<typeof createKeyBody>) => {
  const userId = userFromContext(c).id;
  const body = c.req.valid('json');

  const knownUpstreamIds = await loadKnownUpstreamIds();
  const upstreamErr = validateUpstreamIdsAgainstUserCap(c, body.upstream_ids ?? null, knownUpstreamIds);
  if (upstreamErr) return c.json({ error: upstreamErr }, 400);

  const template = {
    id: crypto.randomUUID(),
    userId,
    name: body.name,
    serverSecret: generateServerSecret(),
    createdAt: new Date().toISOString(),
    upstreamIds: body.upstream_ids ?? null,
    deletedAt: null,
    dumpRetentionSeconds: body.dump_retention_seconds ?? null,
    responsesRetentionSeconds: body.responses_retention_seconds ?? 0,
  } satisfies Omit<ApiKey, 'key'>;

  const result = await writeKeyForRequest(template, body);
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json(apiKeyToJson(result.key, reachableUpstreamIds(knownUpstreamIds, userUpstreamIdsFromContext(c))), 201);
};

export const deleteKey = async (c: AuthedContext) => {
  const id = c.req.param('id')!;
  const owned = await ownedKeyForUser(c, id);
  if (!owned) return c.json({ error: 'Key not found' }, 404);
  // Cut any live SSE subscribers so the dashboard sees a clean disconnect.
  // Broker availability shouldn't block the soft-delete — clients reconcile
  // on the next keys refetch regardless.
  await notifyDisabledBestEffort(id, 'deleteKey');
  await getRepo().apiKeys.softDelete(id);
  return c.json({ ok: true });
};

export const rotateKey = async (c: CtxWithJson<typeof rotateKeyBody>) => {
  const id = c.req.param('id')!;
  const owned = await ownedKeyForUser(c, id);
  if (!owned) return c.json({ error: 'Key not found' }, 404);

  const result = await writeKeyForRequest(owned, c.req.valid('json'));
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json(apiKeyToJson(result.key, reachableUpstreamIds(await loadKnownUpstreamIds(), userUpstreamIdsFromContext(c))));
};

export const updateKey = async (c: CtxWithJson<typeof updateKeyBody>) => {
  const id = c.req.param('id')!;
  const body = c.req.valid('json');

  if (body.name === undefined && body.upstream_ids === undefined && body.dump_retention_seconds === undefined && body.responses_retention_seconds === undefined) {
    return c.json({ error: 'Provide a new name, upstream selection, dump retention, or Stateful Responses retention to update.' }, 400);
  }

  const owned = await ownedKeyForUser(c, id);
  if (!owned) return c.json({ error: 'Key not found' }, 404);

  const knownUpstreamIds = await loadKnownUpstreamIds();
  if (body.upstream_ids !== undefined) {
    const err = validateUpstreamIdsAgainstUserCap(c, body.upstream_ids, knownUpstreamIds);
    if (err) return c.json({ error: err }, 400);
  }

  const updated = await getRepo().apiKeys.update(id, {
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.upstream_ids !== undefined ? { upstreamIds: body.upstream_ids } : {}),
    ...(body.dump_retention_seconds !== undefined ? { dumpRetentionSeconds: body.dump_retention_seconds } : {}),
    ...(body.responses_retention_seconds !== undefined ? { responsesRetentionSeconds: body.responses_retention_seconds } : {}),
  });
  if (updated === null) throw new Error(`API key disappeared during update: ${id}`);

  if (body.dump_retention_seconds !== undefined && body.dump_retention_seconds !== owned.dumpRetentionSeconds) {
    const previous = owned.dumpRetentionSeconds;
    const next = body.dump_retention_seconds;
    if (next === null && previous !== null) await notifyDisabledBestEffort(id, 'updateKey retention disable');
  }

  return c.json(apiKeyToJson(updated, reachableUpstreamIds(knownUpstreamIds, userUpstreamIdsFromContext(c))));
};
