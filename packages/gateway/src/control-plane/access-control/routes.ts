import { checkMany } from '../../access-control/check.ts';
import type { AccessRecordInput, AccessTarget } from '../../access-control/types.ts';
import type { AuthedContext } from '../../middleware/auth.ts';
import type { CtxWithJson } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import type { accessRecordBody, resolveAccessBody } from '../schemas.ts';

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

const writeError = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);

export const listAccessRecords = async (c: AuthedContext) => c.json(await getRepo().accessRecords.list());

export const createAccessRecord = async (c: CtxWithJson<typeof accessRecordBody>) => {
  const input = c.req.valid('json');
  const error = await principalError(input);
  if (error) return c.json({ error }, 400);
  try {
    return c.json(await getRepo().accessRecords.save(input), 201);
  } catch (cause) {
    return c.json({ error: writeError(cause) }, 400);
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
    return c.json({ error: writeError(cause) }, 400);
  }
};

export const deleteAccessRecord = async (c: AuthedContext) => {
  const id = parseRecordId(c.req.param('id')!);
  if (id === null) return c.json({ error: 'invalid access record id' }, 400);
  return await getRepo().accessRecords.delete(id)
    ? c.json({ ok: true })
    : c.json({ error: 'access record not found' }, 404);
};

const requirementsFor = (target: AccessTarget) => target.kind === 'user'
  ? [{ permission: 'User.Audit' as const }]
  : target.kind === 'upstreamModel'
    ? [{ permission: 'Model.Use' as const }]
    : [
        { permission: 'Model.Use' as const },
        { permission: 'Upstream.Audit' as const },
        { permission: 'Upstream.Edit' as const, level: 'models' as const },
        { permission: 'Upstream.Edit' as const, level: 'full' as const },
      ];

export const resolveAccess = async (c: CtxWithJson<typeof resolveAccessBody>) => {
  const { userId, target } = c.req.valid('json');
  const user = await getRepo().users.getById(userId);
  if (!user) return c.json({ error: 'user not found' }, 404);
  const requirements = requirementsFor(target);
  const allowed = await checkMany(user, requirements.map(requirement => ({ target, requirement })));
  if (target.kind === 'user') return c.json({ values: { 'User.Audit': allowed[0] } });
  if (target.kind === 'upstreamModel') return c.json({ values: { 'Model.Use': allowed[0] } });
  return c.json({
    values: {
      'Model.Use': allowed[0],
      'Upstream.Audit': allowed[1],
      'Upstream.Edit': allowed[3] ? 'full' : allowed[2] ? 'models' : 'off',
    },
  });
};
