// Admin-only CRUD for model aliases. Wire shape (snake_case) is in
// `@floway-dev/protocols/common`; this layer maps to the camelCase
// `ModelAliasRecord` the repo stores.

import type { Context } from 'hono';

import { recordToWire, wireToRecord } from './serialize.ts';
import { type CtxWithJson } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import type { ModelAliasRecord } from '../../repo/types.ts';
import type { createAliasBody, updateAliasBody } from '../schemas.ts';

const nextSortOrder = (existing: readonly ModelAliasRecord[]): number =>
  existing.reduce((acc, record) => Math.max(acc, record.sortOrder), -1) + 1;

export const listAliases = async (c: Context) => {
  const records = await getRepo().modelAliases.list();
  return c.json(records.map(recordToWire));
};

export const createAlias = async (c: CtxWithJson<typeof createAliasBody>) => {
  const body = c.req.valid('json');
  const repo = getRepo();

  const collision = await repo.modelAliases.getByName(body.name);
  if (collision) {
    return c.json({ error: `Alias ${body.name} already exists` }, 409);
  }

  const existing = await repo.modelAliases.list();
  const now = new Date().toISOString();
  const record = wireToRecord(body, {
    sortOrder: body.sort_order ?? nextSortOrder(existing),
    createdAt: now,
    updatedAt: now,
  });
  await repo.modelAliases.insert(record);
  return c.json(recordToWire(record), 201);
};

export const updateAlias = async (c: CtxWithJson<typeof updateAliasBody>) => {
  const oldName = c.req.param('name')!;
  const body = c.req.valid('json');
  const repo = getRepo();

  const existing = await repo.modelAliases.getByName(oldName);
  if (!existing) return c.json({ error: 'Alias not found' }, 404);

  if (body.name !== oldName) {
    const collision = await repo.modelAliases.getByName(body.name);
    if (collision) return c.json({ error: `Alias ${body.name} already exists` }, 409);
  }

  const next = wireToRecord(body, {
    // Preserve the original sortOrder unless the client explicitly overrides
    // it; createdAt belongs to the row's first-seen instant and never moves.
    sortOrder: body.sort_order ?? existing.sortOrder,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  });
  await repo.modelAliases.update(oldName, next);
  return c.json(recordToWire(next));
};

export const deleteAlias = async (c: Context) => {
  const name = c.req.param('name')!;
  // Idempotent — success whether or not a row existed. 204 keeps verb-shape
  // parity with DELETE /api/proxies/:id.
  await getRepo().modelAliases.delete(name);
  return c.body(null, 204);
};
