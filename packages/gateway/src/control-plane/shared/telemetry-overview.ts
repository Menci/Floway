import type { Context } from 'hono';

import { userFromContext } from '../../middleware/auth.ts';
import { getRepo } from '../../repo/index.ts';
import type { ApiKey, User } from '../../repo/types.ts';
import { buildKeyToUserMap } from './key-to-user.ts';
import type { TelemetryBucketGranularity } from './telemetry-bucket.ts';

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
  allKeys: ApiKey[];
  ownedKeys: ApiKey[];
  ownedKeyIds: ReadonlySet<string>;
  keyToUser: ReadonlyMap<string, number>;
  users: User[];
}

export const loadTelemetryOverviewIdentity = async (c: Context): Promise<TelemetryOverviewIdentity> => {
  const actor = userFromContext(c);
  const repo = getRepo();
  const [allKeys, users] = await Promise.all([
    repo.apiKeys.listIncludingDeleted(),
    actor.isAdmin ? repo.users.listIncludingDeleted() : Promise.resolve([]),
  ]);
  const ownedKeys = allKeys.filter(key => key.userId === actor.id);
  return {
    actor,
    allKeys,
    ownedKeys,
    ownedKeyIds: new Set(ownedKeys.map(key => key.id)),
    keyToUser: buildKeyToUserMap(allKeys),
    users,
  };
};

export const telemetryIdentityError = (
  identity: TelemetryOverviewIdentity,
  groupBy: string,
  userIds: ReadonlySet<number>,
  keyIds: ReadonlySet<string>,
): { status: 403 | 404; error: string } | null => {
  if (!identity.actor.isAdmin && groupBy === 'userId') {
    return { status: 403, error: 'group_by=userId requires administrator privileges' };
  }
  if (!identity.actor.isAdmin && userIds.size > 0) {
    return { status: 403, error: 'filter_user_id requires administrator privileges' };
  }
  const unknownKeyId = [...keyIds].find(keyId => !identity.ownedKeyIds.has(keyId));
  return unknownKeyId === undefined ? null : { status: 404, error: 'Unknown filter_key_id' };
};

export const telemetryIdentityMetadata = (identity: TelemetryOverviewIdentity) => ({
  users: identity.users
    .map(user => ({ id: user.id, username: user.username }))
    .sort((left, right) => left.id - right.id),
  keys: identity.ownedKeys
    .map(key => ({ id: key.id, name: key.name, createdAt: key.createdAt }))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)),
});
