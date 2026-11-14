import { checkMany } from './check.ts';
import type { UpstreamEditLevel } from './types.ts';
import { getRepo } from '../repo/index.ts';
import type { User } from '../repo/types.ts';

export interface UpstreamAccess {
  audit: boolean;
  edit: UpstreamEditLevel;
}

export const resolveUpstreamAccesses = async (
  subject: User,
  upstreamIds: readonly string[],
): Promise<Map<string, UpstreamAccess>> => {
  if (subject.isAdmin) return new Map(upstreamIds.map(upstreamId => [upstreamId, { audit: true, edit: 'full' }]));
  const allowed = await checkMany(subject, upstreamIds.flatMap(upstreamId => [
    { target: { kind: 'upstream' as const, upstreamId }, requirement: { permission: 'Upstream.Audit' as const } },
    { target: { kind: 'upstream' as const, upstreamId }, requirement: { permission: 'Upstream.Edit' as const, level: 'models' as const } },
    { target: { kind: 'upstream' as const, upstreamId }, requirement: { permission: 'Upstream.Edit' as const, level: 'full' as const } },
  ]));
  return new Map(upstreamIds.map((upstreamId, index) => [upstreamId, {
    audit: allowed[index * 3]!,
    edit: allowed[index * 3 + 2] ? 'full' : allowed[index * 3 + 1] ? 'models' : 'off',
  }]));
};

export const canViewUpstreams = async (subject: User): Promise<boolean> => {
  if (subject.isAdmin) return true;
  const upstreamIds = (await getRepo().upstreams.list()).map(upstream => upstream.id);
  const accesses = await resolveUpstreamAccesses(subject, upstreamIds);
  return [...accesses.values()].some(access => access.audit || access.edit !== 'off');
};

export const resolveUpstreamEditLevel = async (subject: User, upstreamId: string): Promise<UpstreamEditLevel> =>
  (await resolveUpstreamAccesses(subject, [upstreamId])).get(upstreamId)!.edit;

export const fullUpstreamActionError = async (
  subject: User,
  upstreamId: string,
): Promise<{ status: 403 | 404; error: string } | null> => {
  if (upstreamId === '') {
    return subject.isAdmin ? null : { status: 403, error: 'Creating upstream credentials requires administrator privileges' };
  }
  const [editLevel, record] = await Promise.all([
    resolveUpstreamEditLevel(subject, upstreamId),
    getRepo().upstreams.getById(upstreamId),
  ]);
  return editLevel === 'full' && record !== null
    ? null
    : { status: 404, error: 'Upstream not found' };
};
