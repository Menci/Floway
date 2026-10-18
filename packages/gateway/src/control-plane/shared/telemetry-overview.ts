import type { Context } from 'hono';

import { checkMany } from '../../access-control/check.ts';
import { userFromContext } from '../../middleware/auth.ts';
import { getRepo } from '../../repo/index.ts';
import type { ApiKey, StoredUpstreamRecord, User } from '../../repo/types.ts';
import { parseTelemetryHour, type TelemetryBucketGranularity } from '@floway-dev/protocols/common';

interface TelemetryOverviewQuery {
  start?: string;
  end?: string;
  bucket?: TelemetryBucketGranularity;
  timezone?: string;
  timezone_offset_minutes?: string;
}

export interface TelemetryOverviewWindow {
  start: string;
  end: string;
  bucket: TelemetryBucketGranularity;
  timeZone?: string;
  timezoneOffsetMinutes: number;
}

export const readTelemetryOverviewWindow = (
  query: TelemetryOverviewQuery,
): { type: 'ok'; value: TelemetryOverviewWindow } | { type: 'error'; error: string } => {
  if (!query.start || !query.end) {
    return { type: 'error', error: 'start and end query parameters are required (e.g. 2026-03-09T00)' };
  }
  try {
    if (parseTelemetryHour(query.start) >= parseTelemetryHour(query.end)) {
      return { type: 'error', error: 'end must be later than start' };
    }
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    return { type: 'error', error: 'start and end must be valid UTC hours (e.g. 2026-03-09T00)' };
  }
  const timezoneOffsetMinutes = Number(query.timezone_offset_minutes ?? '0');
  if (!Number.isFinite(timezoneOffsetMinutes) || timezoneOffsetMinutes < -1440 || timezoneOffsetMinutes > 1440) {
    return { type: 'error', error: 'timezone_offset_minutes must be between -1440 and 1440' };
  }
  let timeZone: string | undefined;
  if (query.timezone !== undefined) {
    try {
      timeZone = new Intl.DateTimeFormat('en', { timeZone: query.timezone }).resolvedOptions().timeZone;
    } catch {
      return { type: 'error', error: 'timezone must be an IANA time zone' };
    }
  }
  return {
    type: 'ok',
    value: {
      start: query.start,
      end: query.end,
      bucket: query.bucket ?? 'hour',
      timeZone,
      timezoneOffsetMinutes,
    },
  };
};

export interface TelemetryOverviewIdentity {
  actor: ReturnType<typeof userFromContext>;
  ownedKeys: ApiKey[];
  ownedKeyIds: ReadonlySet<string>;
  upstreams: StoredUpstreamRecord[];
  users: User[];
  visibleUserIds: ReadonlySet<number>;
  visibleUpstreams: ReadonlySet<string>;
}

export const loadTelemetryOverviewIdentity = async (c: Context): Promise<TelemetryOverviewIdentity> => {
  const actor = userFromContext(c);
  const repo = getRepo();
  const [ownedKeys, users, upstreams] = await Promise.all([
    repo.apiKeys.listByUserIdIncludingDeleted(actor.id),
    repo.users.listIncludingDeleted(),
    repo.upstreams.list(),
  ]);
  const checks = [
    ...users.map(user => ({
      target: { kind: 'user' as const, userId: user.id },
      requirement: { permission: 'User.Audit' as const },
    })),
    ...upstreams.map(upstream => ({
      target: { kind: 'upstream' as const, upstreamId: upstream.id },
      requirement: { permission: 'Upstream.Audit' as const },
    })),
  ];
  const allowed = await checkMany(actor, checks);
  return {
    actor,
    ownedKeys,
    ownedKeyIds: new Set(ownedKeys.map(key => key.id)),
    upstreams,
    users,
    visibleUserIds: new Set(users.filter((_user, index) => allowed[index]).map(user => user.id)),
    visibleUpstreams: new Set(upstreams.filter((_upstream, index) => allowed[users.length + index]).map(upstream => upstream.id)),
  };
};

export const telemetryUpstreamMetadata = (
  identity: TelemetryOverviewIdentity,
  revealedUpstreamIds: readonly string[],
) => {
  const visibleUpstreamIds = new Set([...identity.visibleUpstreams, ...revealedUpstreamIds]);
  return identity.upstreams
    .filter(upstream => visibleUpstreamIds.has(upstream.id))
    .map(upstream => ({ id: upstream.id, name: upstream.name, hue: upstream.hue }))
    .sort((left, right) => left.id.localeCompare(right.id));
};

export const telemetryIdentityError = (
  identity: TelemetryOverviewIdentity,
  keyIds: ReadonlySet<string>,
): { status: 403 | 404; error: string } | null => {
  const unknownKeyId = [...keyIds].find(keyId => !identity.ownedKeyIds.has(keyId));
  return unknownKeyId === undefined ? null : { status: 404, error: 'Unknown filter_key_id' };
};

export const telemetryRecordVisible = (
  identity: TelemetryOverviewIdentity,
  keyId: string,
  upstream: string | null,
  keyToUser: ReadonlyMap<string, number>,
): boolean => identity.actor.isAdmin
  || identity.visibleUserIds.has(keyToUser.get(keyId) ?? 0)
  || (upstream !== null && identity.visibleUpstreams.has(upstream));

export const telemetryIdentityMetadata = (
  identity: TelemetryOverviewIdentity,
  revealedUserIds: readonly number[],
) => {
  const visibleUserIds = new Set([...identity.visibleUserIds, ...revealedUserIds]);
  return {
    users: identity.users
      .filter(user => visibleUserIds.has(user.id))
      .map(user => ({ id: user.id, username: user.username }))
      .sort((left, right) => left.id - right.id),
    keys: identity.ownedKeys
      .map(key => ({ id: key.id, name: key.name, createdAt: key.createdAt }))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)),
  };
};
