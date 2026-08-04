import type { DisplayWebSearchUsageByKeyRecord, DisplayWebSearchUsageByUserRecord } from './search-usage/aggregate.ts';
import type { DashboardUsageByUserRecord, DashboardUsageRecord } from './token-usage/aggregate.ts';

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
  records: Array<DashboardUsageRecord & {
    keyName: string;
    keyCreatedAt: string;
  }>;
  keys: UsageKeyMetadata[];
}

export interface TokenUsageByUserResponse {
  view: 'all-by-user';
  records: DashboardUsageByUserRecord[];
  users: UsageUserMetadata[];
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
