import type { DisplayWebSearchUsageByKeyRecord, DisplayWebSearchUsageByUserRecord } from './search-usage/aggregate.ts';
import type { TelemetryKeyMetadata as UsageKeyMetadata, TelemetryOverviewSnapshot, TelemetryUserMetadata as UsageUserMetadata } from './shared/telemetry-overview-types.ts';
import type { DisplayUsageByUserRecord, DisplayUsageRecord } from './token-usage/aggregate.ts';
import type { UsageOverviewResult } from '../repo/types.ts';

export type { UsageKeyMetadata, UsageUserMetadata };
export type { TelemetryOverviewScope as TokenUsageOverviewScope } from './shared/telemetry-overview-types.ts';

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

export type TokenUsageOverviewResponse = TelemetryOverviewSnapshot<TokenUsageOverviewBucket>;

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
