import { resolveEffectiveAssignments } from '../../access-control/resolution.ts';
import { AccessRecordConflictError } from '../../access-control/types.ts';
import type { AccessPrincipal, AccessRecordInput } from '../../access-control/types.ts';
import type { AuthedContext } from '../../middleware/auth.ts';
import type { CtxWithJson } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import type { accessRecordBody, reorderAccessRecordsBody, resolveAccessBody } from '../schemas.ts';

const parseRecordId = (raw: string): number | null => {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
};

const principalError = async (input: AccessRecordInput): Promise<string | null> => {
  const repo = getRepo();
  const exists = input.principal.kind === 'user'
    ? await repo.users.getById(input.principal.id)
    : await repo.groups.getById(input.principal.id);
  return exists ? null : `Unknown ${input.principal.kind} principal ${input.principal.id}`;
};

export const listAccessRecords = async (c: AuthedContext) => c.json(await getRepo().accessRecords.list());

export const createAccessRecord = async (c: CtxWithJson<typeof accessRecordBody>) => {
  const input = c.req.valid('json');
  const error = await principalError(input);
  if (error) return c.json({ error }, 400);
  try {
    return c.json(await getRepo().accessRecords.save(input), 201);
  } catch (cause) {
    if (cause instanceof AccessRecordConflictError) return c.json({ error: cause.message }, 409);
    throw cause;
  }
};

export const updateAccessRecord = async (c: CtxWithJson<typeof accessRecordBody>) => {
  const id = parseRecordId(c.req.param('id')!);
  if (id === null) return c.json({ error: 'invalid access record id' }, 400);
  const input = c.req.valid('json');
  const error = await principalError(input);
  if (error) return c.json({ error }, 400);
  try {
    const record = await getRepo().accessRecords.replace(id, input);
    return record ? c.json(record) : c.json({ error: 'access record not found' }, 404);
  } catch (cause) {
    if (cause instanceof AccessRecordConflictError) return c.json({ error: cause.message }, 409);
    throw cause;
  }
};

export const deleteAccessRecord = async (c: AuthedContext) => {
  const id = parseRecordId(c.req.param('id')!);
  if (id === null) return c.json({ error: 'invalid access record id' }, 400);
  return await getRepo().accessRecords.delete(id)
    ? c.json({ ok: true })
    : c.json({ error: 'access record not found' }, 404);
};

export const resolveAccess = async (c: CtxWithJson<typeof resolveAccessBody>) => {
  const { principal, scope, excludeRecordId } = c.req.valid('json');
  const repo = getRepo();
  const subject = principal.kind === 'user' ? await repo.users.getById(principal.id) : await repo.groups.getById(principal.id);
  if (!subject) return c.json({ error: `${principal.kind} not found` }, 404);
  const groupIds = principal.kind === 'user' ? await repo.groups.listIdsByUserId(principal.id) : [];
  const principals: AccessPrincipal[] = [principal, ...groupIds.map(id => ({ kind: 'group' as const, id }))];
  const [records, targetGroups] = await Promise.all([
    repo.accessRecords.listByPrincipals(principals),
    scope.kind === 'user' ? repo.groups.listIdsByUserId(scope.userId) : Promise.resolve([]),
  ]);
  const resolution = resolveEffectiveAssignments(
    records.filter(record => record.id !== excludeRecordId),
    scope,
    new Set(targetGroups),
    'isAdmin' in subject && subject.isAdmin,
  );
  return c.json(resolution);
};

export const reorderAccessRecords = async (c: CtxWithJson<typeof reorderAccessRecordsBody>) => {
  const { expectedIds, ids } = c.req.valid('json');
  const repo = getRepo();
  const first = await repo.accessRecords.getById(expectedIds[0]!);
  if (first?.scope.kind !== 'upstreamModel') return c.json({ error: 'Rules do not belong to a model-pattern reorder segment.' }, 409);
  const records = await repo.accessRecords.reorderModel(first.scope.upstreamId, expectedIds, ids);
  return records === null
    ? c.json({ error: 'Rules changed or cross a fixed priority boundary. Refresh before reordering.' }, 409)
    : c.json({ records });
};
