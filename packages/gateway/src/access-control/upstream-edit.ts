import { checkMany } from './check.ts';
import type { UpstreamEditLevel } from './types.ts';
import type { User } from '../repo/types.ts';

export const resolveUpstreamEditLevels = async (
  subject: User,
  upstreamIds: readonly string[],
): Promise<Map<string, UpstreamEditLevel>> => {
  const allowed = await checkMany(subject, upstreamIds.flatMap(upstreamId => [
    { target: { kind: 'upstream' as const, upstreamId }, requirement: { permission: 'Upstream.Edit' as const, level: 'models' as const } },
    { target: { kind: 'upstream' as const, upstreamId }, requirement: { permission: 'Upstream.Edit' as const, level: 'full' as const } },
  ]));
  return new Map(upstreamIds.map((upstreamId, index) => [
    upstreamId,
    allowed[index * 2 + 1] ? 'full' : allowed[index * 2] ? 'models' : 'off',
  ]));
};

export const resolveUpstreamEditLevel = async (subject: User, upstreamId: string): Promise<UpstreamEditLevel> =>
  (await resolveUpstreamEditLevels(subject, [upstreamId])).get(upstreamId)!;

export const fullUpstreamActionError = async (
  subject: User,
  upstreamId: string,
): Promise<{ status: 403 | 404; error: string } | null> => {
  if (upstreamId === '') {
    return subject.isAdmin ? null : { status: 403, error: 'Creating upstream credentials requires administrator privileges' };
  }
  return await resolveUpstreamEditLevel(subject, upstreamId) === 'full'
    ? null
    : { status: 404, error: 'Upstream not found' };
};
