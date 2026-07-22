import { getDumpStore, notifyDisabledBestEffort } from '../../dump/registry.ts';
import { type AuthedContext, userFromContext, userUpstreamIdsFromContext } from '../../middleware/auth.ts';
import { type CtxWithJson } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import { generateResponsesStateEpoch } from '../../repo/responses-retention.ts';
import type { ApiKey } from '../../repo/types.ts';
import { CUSTOM_API_KEY_MAX_LENGTH, generateApiKeyToken, type KeySource } from '../../shared/api-key-tokens.ts';
import { generateServerSecret } from '../../shared/server-secret.ts';
import type { createKeyBody, rotateKeyBody, updateKeyBody } from '../schemas.ts';
import { ownedKeyOr404 } from '../shared/owned-key.ts';

const GENERATED_KEY_RETRIES = 5;

const apiKeyToJson = (key: ApiKey) => ({
  id: key.id,
  name: key.name,
  key: key.key,
  created_at: key.createdAt,
  last_used_at: key.lastUsedAt ?? null,
  upstream_ids: key.upstreamIds,
  dump_retention_seconds: key.dumpRetentionSeconds,
  responses_retention_seconds: key.responsesRetentionSeconds,
});

const normalizeCustomKey = (value: unknown): string | Response => {
  if (typeof value !== 'string') {
    return Response.json({ error: 'custom_key is required when key_source is custom' }, { status: 400 });
  }
  const trimmed = value.trim();
  if (!trimmed) return Response.json({ error: 'custom_key is required when key_source is custom' }, { status: 400 });
  if (trimmed.length > CUSTOM_API_KEY_MAX_LENGTH) {
    return Response.json({ error: `custom_key must be at most ${CUSTOM_API_KEY_MAX_LENGTH} characters` }, { status: 400 });
  }
  return trimmed;
};

const duplicateKeyResponse = () =>
  Response.json({ error: 'An API key with that raw key already exists.' }, { status: 409 });

const isRawKeyUniqueConstraint = (error: unknown): boolean =>
  /UNIQUE constraint failed: api_keys\.key(?:\b|$)/i.test(error instanceof Error ? error.message : String(error));

const findAnyByRawKey = async (rawKey: string): Promise<ApiKey | null> =>
  (await getRepo().apiKeys.listIncludingDeleted()).find(key => key.key === rawKey) ?? null;

const allocateGeneratedKey = async (
  persist: (rawKey: string) => Promise<ApiKey>,
): Promise<ApiKey | Response> => {
  for (let i = 0; i < GENERATED_KEY_RETRIES; i++) {
    const rawKey = generateApiKeyToken();
    if (await findAnyByRawKey(rawKey)) continue;
    try {
      return await persist(rawKey);
    } catch (error) {
      if (isRawKeyUniqueConstraint(error)) continue;
      throw error;
    }
  }
  return Response.json({ error: 'Could not allocate a unique API key; retry the request.' }, { status: 500 });
};

const useCustomKey = async (
  ownerId: string,
  rawKey: string,
  persist: (rawKey: string) => Promise<ApiKey>,
): Promise<ApiKey | Response> => {
  const existing = await findAnyByRawKey(rawKey);
  if (existing && existing.id !== ownerId) return duplicateKeyResponse();
  try {
    return await persist(rawKey);
  } catch (error) {
    if (isRawKeyUniqueConstraint(error)) return duplicateKeyResponse();
    throw error;
  }
};

// Reject custom_key on a non-custom source so a caller cannot smuggle a
// bring-your-own key past the picker they explicitly opted out of.
const writeKeyForRequest = async (
  ownerId: string,
  body: { key_source?: KeySource; custom_key?: string },
  persist: (rawKey: string) => Promise<ApiKey>,
): Promise<ApiKey | Response> => {
  const source = body.key_source ?? 'generate';
  if (source !== 'custom' && body.custom_key !== undefined) {
    return Response.json({ error: 'custom_key is only valid when key_source is custom' }, { status: 400 });
  }
  if (source === 'custom') {
    const customKey = normalizeCustomKey(body.custom_key);
    if (customKey instanceof Response) return customKey;
    return await useCustomKey(ownerId, customKey, persist);
  }
  return await allocateGeneratedKey(persist);
};

const validateUpstreamIdsAgainstUserCap = async (
  c: AuthedContext,
  proposed: readonly string[] | null,
): Promise<string | null> => {
  if (proposed === null) return null;
  const upstreams = await getRepo().upstreams.list();
  const known = new Set(upstreams.map(u => u.id));
  const unknown = proposed.filter(id => !known.has(id));
  if (unknown.length) return `Unknown upstream(s): ${unknown.join(', ')}`;

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
  const keys = await getRepo().apiKeys.listByUserId(userId);
  return c.json(keys.map(apiKeyToJson));
};

export const createKey = async (c: CtxWithJson<typeof createKeyBody>) => {
  const userId = userFromContext(c).id;
  const body = c.req.valid('json');

  const upstreamErr = await validateUpstreamIdsAgainstUserCap(c, body.upstream_ids ?? null);
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
    responsesStateEpoch: generateResponsesStateEpoch(),
  } satisfies Omit<ApiKey, 'key'>;

  const key = await writeKeyForRequest(template.id, body, async rawKey => {
    const created = { ...template, key: rawKey };
    await getRepo().apiKeys.save(created);
    return created;
  });
  if (key instanceof Response) return key;
  return c.json(apiKeyToJson(key), 201);
};

export const deleteKey = async (c: AuthedContext) => {
  const id = c.req.param('id')!;
  const owned = await ownedKeyOr404(c, id);
  if (owned instanceof Response) return owned;
  // Purge dump state before the soft-delete so a purge failure leaves a
  // retriable, still-owned key rather than a half-deleted row whose dump
  // records are orphaned beyond the operator's reach.
  await getDumpStore().purgeAll(id);
  // Cut any live SSE subscribers so the dashboard sees a clean disconnect.
  // Broker availability shouldn't block the soft-delete — clients reconcile
  // on the next keys refetch regardless.
  await notifyDisabledBestEffort(id, 'deleteKey');
  await getRepo().apiKeys.softDelete(id, generateResponsesStateEpoch());
  return c.json({ ok: true });
};

export const rotateKey = async (c: CtxWithJson<typeof rotateKeyBody>) => {
  const id = c.req.param('id')!;
  const owned = await ownedKeyOr404(c, id);
  if (owned instanceof Response) return owned;

  const updated = await writeKeyForRequest(owned.id, c.req.valid('json'), async rawKey => {
    const persisted = await getRepo().apiKeys.update(id, { key: rawKey });
    if (persisted === null) throw new Error(`API key disappeared during rotation: ${id}`);
    return persisted;
  });
  if (updated instanceof Response) return updated;
  return c.json(apiKeyToJson(updated));
};

export const updateKey = async (c: CtxWithJson<typeof updateKeyBody>) => {
  const id = c.req.param('id')!;
  const body = c.req.valid('json');

  if (body.name === undefined && body.upstream_ids === undefined && body.dump_retention_seconds === undefined && body.responses_retention_seconds === undefined) {
    return c.json({ error: 'Provide a new name, upstream selection, dump retention, or Stateful Responses retention to update.' }, 400);
  }

  const owned = await ownedKeyOr404(c, id);
  if (owned instanceof Response) return owned;

  if (body.upstream_ids !== undefined) {
    const err = await validateUpstreamIdsAgainstUserCap(c, body.upstream_ids);
    if (err) return c.json({ error: err }, 400);
  }

  const updated = await getRepo().apiKeys.update(id, {
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.upstream_ids !== undefined ? { upstreamIds: body.upstream_ids } : {}),
    ...(body.dump_retention_seconds !== undefined ? { dumpRetentionSeconds: body.dump_retention_seconds } : {}),
    ...(body.responses_retention_seconds !== undefined ? { responsesRetentionSeconds: body.responses_retention_seconds } : {}),
  });
  if (updated === null) throw new Error(`API key disappeared during update: ${id}`);

  if (body.dump_retention_seconds !== undefined) {
    const next = body.dump_retention_seconds;
    if (next === null) {
      await getDumpStore().purgeAll(id);
      await notifyDisabledBestEffort(id, 'updateKey retention disable');
    } else {
      await getDumpStore().purgeExpired(id, next);
    }
  }

  return c.json(apiKeyToJson(updated));
};
