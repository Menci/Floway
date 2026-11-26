import { api, callApi, type ApiResult } from '../../../api/client';
import { calendarDate } from '../../../lib/calendar-date';
import { decimalStringToPlottableNumber } from '../../../lib/decimal-display';
import { canContinueTelemetrySnapshot, mergeTelemetrySnapshot, sameTelemetryScope } from '../../telemetry/snapshot';
import { usageOverviewForDisplay } from '../overview';
import { summarizeUsage } from '../plot';
import type { DisplayUsageRecord } from '../types';
import type { TokenUsageOverviewResponse } from '@floway-dev/gateway/browser';
import { parseTelemetryHour, TELEMETRY_HOUR_MS, telemetryDayOrdinal, telemetryHourKey, type DecimalString } from '@floway-dev/protocols/browser';

const DAY_MS = 24 * TELEMETRY_HOUR_MS;

// The overview's day buckets are fixed 24-hour spans counted from `start`. A
// start on the first day of 1970 at the hour of today's local midnight (rounded
// up to the hour, like the page's own ranges) covers every recorded hour and
// makes each span one local day at the current UTC offset.
export const usageHistoryStart = (nowMs: number): string => {
  const midnight = new Date(nowMs);
  midnight.setHours(0, 0, 0, 0);
  const origin = Math.ceil(midnight.getTime() / TELEMETRY_HOUR_MS) * TELEMETRY_HOUR_MS;
  return telemetryHourKey((origin % DAY_MS + DAY_MS) % DAY_MS);
};

// A span is named by the local date at its midpoint, which stays on the
// intended day when a daylight-saving change shifts the span by an hour.
const spanDate = (bucket: string): string => calendarDate(new Date(parseTelemetryHour(bucket) + DAY_MS / 2));

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
  const recordsByDate = Map.groupBy(display.series, record => spanDate(record.bucket));
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
// rescans the last two hours instead of the whole history. A changed start
// (the viewer's UTC offset moved) reads the history again.
export const createUsageHistoryLoader = (): UsageHistoryLoader => {
  let latest: { start: string; snapshot: TokenUsageOverviewResponse } | undefined;
  return async (nowMs, signal) => {
    const start = usageHistoryStart(nowMs);
    const end = telemetryHourKey(Math.floor(nowMs / TELEMETRY_HOUR_MS) * TELEMETRY_HOUR_MS + TELEMETRY_HOUR_MS);
    const query = {
      start,
      end,
      format: 'fixed-buckets' as const,
      bucket: 'day' as const,
      group_by: 'model' as const,
    };
    const load = (cursor: string | undefined) => callApi(() => api.api['token-usage'].overview.$get({ query: cursor === undefined ? query : { ...query, cursor } }, { init: { signal } }));
    let previous = latest?.start === start ? latest.snapshot : undefined;
    let result = await load(canContinueTelemetrySnapshot(previous, query) ? previous.cursor : undefined);
    if (result.error) return result;
    if (previous && !result.data.reset && !sameTelemetryScope(previous.scope, result.data.scope)) {
      previous = undefined;
      if (!signal.aborted) latest = undefined;
      result = await load(undefined);
      if (result.error) return result;
    }
    const snapshot = mergeTelemetrySnapshot(previous, result.data, start);
    if (!signal.aborted) latest = { start, snapshot };
    return { data: summarizeUsageHistory(snapshot) };
  };
};
