import type { AuthedContext } from '../../middleware/auth.ts';
import type { CtxWithJson } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import type { Group } from '../../repo/types.ts';
import type { createGroupBody, updateGroupBody } from '../schemas.ts';

const parseGroupId = (raw: string): number | null => {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
};

const unknownMembersError = async (memberIds: readonly number[]): Promise<string | null> => {
  const users = new Set((await getRepo().users.list()).map(user => user.id));
  const missing = memberIds.filter(id => !users.has(id));
  return missing.length === 0 ? null : `Unknown user ids: ${missing.join(', ')}`;
};

const groupWire = async (group: Group) => {
  const memberIds = await getRepo().groups.listMemberIds(group.id);
  return { ...group, memberIds };
};

export const listGroups = async (c: AuthedContext) => {
  const repo = getRepo();
  const [groups, memberships] = await Promise.all([repo.groups.list(), repo.groups.listMemberships()]);
  return c.json(groups.map(group => ({ ...group, memberIds: memberships.get(group.id) ?? [] })));
};

export const createGroup = async (c: CtxWithJson<typeof createGroupBody>) => {
  const body = c.req.valid('json');
  const repo = getRepo();
  if (await repo.groups.findByName(body.name)) return c.json({ error: 'That group name is already taken (names are case-insensitive).' }, 400);
  const memberIds = body.memberIds ?? [];
  const memberError = await unknownMembersError(memberIds);
  if (memberError) return c.json({ error: memberError }, 400);
  const group = await repo.groups.create(body.name, body.hue);
  await repo.groups.replaceMembers(group.id, memberIds);
  return c.json(await groupWire(group), 201);
};

export const updateGroup = async (c: CtxWithJson<typeof updateGroupBody>) => {
  const id = parseGroupId(c.req.param('id')!);
  if (id === null) return c.json({ error: 'invalid group id' }, 400);
  const repo = getRepo();
  const existing = await repo.groups.getById(id);
  if (!existing) return c.json({ error: 'group not found' }, 404);
  const body = c.req.valid('json');
  if (body.name !== undefined && body.name !== existing.name) {
    const duplicate = await repo.groups.findByName(body.name);
    if (duplicate && duplicate.id !== id) return c.json({ error: 'group name taken' }, 400);
  }
  if (body.memberIds !== undefined) {
    const memberError = await unknownMembersError(body.memberIds);
    if (memberError) return c.json({ error: memberError }, 400);
  }
  const next = { ...existing, ...(body.name === undefined ? {} : { name: body.name }), ...(body.hue === undefined ? {} : { hue: body.hue }) };
  await repo.groups.save(next);
  if (body.memberIds !== undefined) await repo.groups.replaceMembers(id, body.memberIds);
  return c.json(await groupWire(next));
};

export const deleteGroup = async (c: AuthedContext) => {
  const id = parseGroupId(c.req.param('id')!);
  if (id === null) return c.json({ error: 'invalid group id' }, 400);
  const repo = getRepo();
  if (!await repo.groups.getById(id)) return c.json({ error: 'group not found' }, 404);
  await repo.accessRecords.deleteByPrincipal({ kind: 'group', id });
  await repo.groups.softDelete(id);
  return c.json({ ok: true });
};

export const setGroupMember = (included: boolean) => async (c: AuthedContext) => {
  const id = parseGroupId(c.req.param('id')!);
  const userId = parseGroupId(c.req.param('userId')!);
  if (id === null || userId === null) return c.json({ error: 'invalid group or user id' }, 400);
  const repo = getRepo();
  if (!await repo.groups.getById(id)) return c.json({ error: 'group not found' }, 404);
  if (!await repo.users.getById(userId)) return c.json({ error: 'user not found' }, 404);
  await repo.groups.setMember(id, userId, included);
  return c.json({ ok: true });
};
