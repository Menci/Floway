import type { DisplayWebSearchUsageByKeyRecord, DisplayWebSearchUsageByUserRecord } from './search-usage/aggregate.ts';
import type { DisplayUsageByUserRecord, DisplayUsageRecord } from './token-usage/aggregate.ts';
import type { UsageOverviewGroupBy, UsageOverviewRecord } from '../repo/types.ts';

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

export interface TokenUsageOverviewResponse {
  series: UsageOverviewRecord[];
  axes: Record<UsageOverviewGroupBy | 'none', UsageOverviewRecord[]>;
  dimensionValues: {
    keyIds: string[];
    userIds: number[];
    models: string[];
    upstreams: string[];
  };
  users: UsageUserMetadata[];
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
