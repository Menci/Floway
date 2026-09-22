// Ollama Cloud account usage. The windows are percentages with no reset
// timestamp -- that is everything the upstream reports -- so a window is a
// percentage and nothing else.

import { FIVE_HOUR_WINDOW_MINUTES, SEVEN_DAY_WINDOW_MINUTES } from './subscription-quota';
import type { UpstreamRecord } from '../../api/types';
import { formatUsd } from '../../lib/decimal-display';
import { decimalStringIsZero, parseNonNegativeDecimalString } from '@floway-dev/protocols/common';

export type OllamaRecord = Extract<UpstreamRecord, { kind: 'ollama' }>;

// An account is an ollama.com fact; a self-hosted daemon has none. The operator
// owns whether account reporting is on, so this only decides what the editor
// suggests when the endpoint is typed.
export const isOllamaCloudBaseUrl = (baseUrl: string): boolean => {
  try {
    return new URL(baseUrl).hostname === 'ollama.com';
  } catch {
    // A half-typed URL in the form field is not a cloud endpoint yet.
    return false;
  }
};

// Ollama states the session allowance resets every five hours and the other
// weekly; the endpoint reports neither the length nor a reset time, so the
// lengths are stated here and the field name is what selects them.
// https://ollama.com/pricing
const WINDOW_MINUTES = {
  session: FIVE_HOUR_WINDOW_MINUTES,
  weekly: SEVEN_DAY_WINDOW_MINUTES,
} as const;

export interface UsageWindow {
  key: keyof typeof WINDOW_MINUTES;
  minutes: number;
  percent: number;
}

const isRecordValue = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// `usage` is a 0..1 fraction of the plan's allowance for that window. It is
// kept to a decimal place on the way out: an early-in-the-window reading like
// 0.046 rounds to a whole "5%" that reads as coarser than the upstream is.
//
// The endpoint also reports a per-model request count per window. It is not
// shown: Ollama meters the allowance by model and by input, cached-input, and
// output tokens, so a request count is a different quantity from the
// percentage beside it and reads as an explanation of it.
// https://ollama.com/pricing
const readWindow = (key: UsageWindow['key'], value: unknown): UsageWindow | null => {
  if (!isRecordValue(value) || typeof value.usage !== 'number' || !Number.isFinite(value.usage)) return null;
  return { key, minutes: WINDOW_MINUTES[key], percent: Math.round(value.usage * 1000) / 10 };
};

export const readWindows = (data: unknown): UsageWindow[] => {
  const limits = isRecordValue(data) ? data.limits : null;
  if (!isRecordValue(limits)) return [];
  return [readWindow('session', limits.session), readWindow('weekly', limits.weekly)]
    .filter((usageWindow): usageWindow is UsageWindow => usageWindow !== null);
};

// What the account has been charged, as a plain decimal string in USD, over the
// period the same block names. The period is Ollama's own identifier and is
// forwarded as it arrived, so a period this dashboard cannot name leaves the
// figure unqualified rather than claiming a window the upstream did not state.
export interface ActivityCost {
  amount: string;
  period: string | null;
}

export const readActivityCost = (data: unknown): ActivityCost | null => {
  const activity = isRecordValue(data) ? data.activity : null;
  if (!isRecordValue(activity) || typeof activity.cost !== 'string') return null;
  const period = isRecordValue(activity.period) ? activity.period.type : null;
  return { amount: activity.cost, period: typeof period === 'string' ? period : null };
};

// The figure reaches the dashboard on the same money ladder every other cost
// does -- "0.00000" reads as "$0", a sub-cent charge keeps its digits. The
// amount is upstream-owned text, so one Ollama does not write as a canonical
// decimal is forwarded as it arrived rather than dropped.
export const activityCostText = (cost: string): string => {
  try {
    return formatUsd(parseNonNegativeDecimalString(cost));
  } catch {
    return `$${cost}`;
  }
};

// An account that has spent nothing still reports "0.00000". On the card that
// zero is worth its line -- it is the difference between spending nothing and
// reporting nothing -- but a row of live readings is scanned, and a figure that
// says nothing happened earns none of that width. A charge the money ladder
// cannot read is not zero, so it stays.
export const isZeroActivityCost = (cost: string): boolean => {
  try {
    return decimalStringIsZero(parseNonNegativeDecimalString(cost));
  } catch {
    return false;
  }
};
