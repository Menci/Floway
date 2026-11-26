import { api, callApi, type ApiResult } from '../../../api/client';
import { decimalStringToPlottableNumber } from '../../../lib/decimal-display';
import { mergeUsageOverview, usageOverviewCursor, usageOverviewForDisplay } from '../overview';
import { summarizeUsage } from '../plot';
import type { DisplayUsageRecord } from '../types';
import type { TokenUsageOverviewResponse } from '@floway-dev/gateway/browser';
import { TELEMETRY_HOUR_MS, telemetryDayOrdinal, telemetryHourKey, type DecimalString } from '@floway-dev/protocols/browser';

// Every recorded hour is later than this, so one window covers the whole history.
export const USAGE_HISTORY_START = '1970-01-01T00';

export interface UsageDay {
  // Days since 1970-01-01 of the local calendar date; consecutive days differ by one.
  ordinal: number;
  date: string;
  tokens: DecimalString;
  requests: number;
  topModel: string | null;
}

export interface UsageHistory {
  days: ReadonlyMap<number, UsageDay>;
  tokens: DecimalString;
  requests: number;
  models: ReadonlyArray<{ model: string; tokens: DecimalString }>;
}

const tokensOf = (records: DisplayUsageRecord[]): DecimalString => summarizeUsage(records).total;

export const summarizeUsageHistory = (snapshot: TokenUsageOverviewResponse): UsageHistory => {
  const display = usageOverviewForDisplay(snapshot, 'model');
  const recordsByDate = Map.groupBy(display.series, record => record.bucket);
  const days = new Map<number, UsageDay>();
  for (const [date, records] of recordsByDate) {
    const summary = summarizeUsage(records);
    let topModel: string | null = null;
    let topTokens = 0;
    for (const record of records) {
      const tokens = decimalStringToPlottableNumber(tokensOf([record]));
      if (tokens > topTokens) {
        topModel = record.group;
        topTokens = tokens;
      }
    }
    const ordinal = telemetryDayOrdinal(date);
    days.set(ordinal, { ordinal, date, tokens: summary.total, requests: summary.requests, topModel });
  }
  const total = summarizeUsage(display.axes.none);
  return {
    days,
    tokens: total.total,
    requests: total.requests,
    models: display.axes.model
      .map(record => ({ model: record.group, tokens: tokensOf([record]) }))
      .filter(entry => decimalStringToPlottableNumber(entry.tokens) > 0)
      .sort((left, right) => decimalStringToPlottableNumber(right.tokens) - decimalStringToPlottableNumber(left.tokens)),
  };
};

export type UsageHistoryLoader = (nowMs: number, signal: AbortSignal) => Promise<ApiResult<UsageHistory>>;

// Daily buckets from the overview endpoint, resumed from its cursor so a poll
// rescans the last two hours instead of the whole history.
export const createUsageHistoryLoader = (): UsageHistoryLoader => {
  let latest: { timezone: string; snapshot: TokenUsageOverviewResponse } | undefined;
  return async (nowMs, signal) => {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const end = telemetryHourKey(Math.floor(nowMs / TELEMETRY_HOUR_MS) * TELEMETRY_HOUR_MS + TELEMETRY_HOUR_MS);
    const query = {
      start: USAGE_HISTORY_START,
      end,
      format: 'buckets' as const,
      bucket: 'day' as const,
      group_by: 'model' as const,
      timezone,
      timezone_offset_minutes: String(new Date(nowMs).getTimezoneOffset()),
    };
    const load = (cursor: string | undefined) => callApi(() => api.api['token-usage'].overview.$get({ query: cursor === undefined ? query : { ...query, cursor } }, { init: { signal } }));
    let previous = latest?.timezone === timezone ? latest.snapshot : undefined;
    let result = await load(usageOverviewCursor(previous, USAGE_HISTORY_START, end));
    if (result.error) return result;
    if (previous && !result.data.reset && JSON.stringify(previous.scope) !== JSON.stringify(result.data.scope)) {
      previous = undefined;
      if (!signal.aborted) latest = undefined;
      result = await load(undefined);
      if (result.error) return result;
    }
    const snapshot = mergeUsageOverview(previous, result.data, USAGE_HISTORY_START);
    if (!signal.aborted) latest = { timezone, snapshot };
    return { data: summarizeUsageHistory(snapshot) };
  };
};
