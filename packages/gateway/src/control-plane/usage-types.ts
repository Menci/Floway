import type { DisplayWebSearchUsageByKeyRecord, DisplayWebSearchUsageByUserRecord } from './search-usage/aggregate.ts';
import type { DisplayUsageByUserRecord, DisplayUsageRecord } from './token-usage/aggregate.ts';
import type { UsageOverviewResult } from '../repo/types.ts';

export interface UsageKeyMetadata {
  id: string;
  name: string;
  createdAt: string;
}

export interface UsageUserMetadata {
  id: number;
  username: string;
}

export interface TokenUsageByKeyResponse {
  view: 'self-by-key';
  records: Array<DisplayUsageRecord & {
    keyName: string;
    keyCreatedAt: string;
  }>;
  keys: UsageKeyMetadata[];
}

export interface TokenUsageByUserResponse {
  view: 'all-by-user';
  records: DisplayUsageByUserRecord[];
  users: UsageUserMetadata[];
}

export interface TokenUsageOverviewBucket extends Omit<UsageOverviewResult, 'firstHour' | 'lastHour'> {
  start: string;
  end: string;
}

export interface TokenUsageOverviewScope {
  actorId: number;
  ownedKeyIds: string[];
  visibility: 'owned-keys' | 'all' | { userIds: number[]; upstreamIds: string[] };
}

export interface TokenUsageOverviewResponse {
  cursor: string;
  reset: boolean;
  start: string;
  end: string;
  buckets: TokenUsageOverviewBucket[];
  scope: TokenUsageOverviewScope;
  metadataVisibility: { complete: boolean; userIds: number[]; upstreamIds: string[] };
  users: UsageUserMetadata[];
  upstreams: Array<{ id: string; name: string; hue: number }>;
  keys: UsageKeyMetadata[];
}

export interface SearchUsageByKeyResponse {
  view: 'self-by-key';
  records: Array<DisplayWebSearchUsageByKeyRecord & {
    keyName: string;
    keyCreatedAt: string;
  }>;
  keys: UsageKeyMetadata[];
}

export interface SearchUsageByUserResponse {
  view: 'all-by-user';
  records: DisplayWebSearchUsageByUserRecord[];
  users: UsageUserMetadata[];
}
