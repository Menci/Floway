import type { DisplayWebSearchUsageByKeyRecord, DisplayWebSearchUsageByUserRecord } from './search-usage/aggregate.ts';
import type { DisplayUsageByUserRecord, DisplayUsageRecord } from './token-usage/aggregate.ts';
import type { WebSearchConfig } from '../shared/web-search-providers.ts';

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
  records: Array<DisplayUsageRecord & {
    keyName: string;
    keyCreatedAt: string;
  }>;
  keys: UsageKeyMetadata[];
}

export interface TokenUsageByUserResponse {
  records: DisplayUsageByUserRecord[];
  users: UsageUserMetadata[];
}

export interface SearchUsageByKeyResponse {
  records: Array<DisplayWebSearchUsageByKeyRecord & {
    keyName: string;
    keyCreatedAt: string;
  }>;
  keys: UsageKeyMetadata[];
  activeProvider: WebSearchConfig['provider'];
}

export interface SearchUsageByUserResponse {
  records: DisplayWebSearchUsageByUserRecord[];
  users: UsageUserMetadata[];
  activeProvider: WebSearchConfig['provider'];
}
