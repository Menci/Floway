import { FIVE_HOUR_WINDOW_MINUTES, SEVEN_DAY_WINDOW_MINUTES } from './subscription-quota';
import type { UpstreamRecord } from '../../api/types';
import type { TFunction } from '../../i18n/translation';
import { formatUsd } from '../../lib/decimal-display';
import { shortDate } from '../../lib/format-time';
import { parseNonNegativeDecimalString } from '@floway-dev/protocols/browser';
import type { OllamaAccountUsage } from '@floway-dev/provider-ollama/browser';

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

// Legacy limits still have five-hour and weekly windows.
// https://ollama.com/blog/transparent-pricing
const WINDOW_MINUTES = { session: FIVE_HOUR_WINDOW_MINUTES, weekly: SEVEN_DAY_WINDOW_MINUTES } as const;

export const readWindows = (included: OllamaAccountUsage['included']) => included.kind === 'credits' ? [] : (['session', 'weekly'] as const).map(key => ({
  key, minutes: WINDOW_MINUTES[key], percent: Math.round((100 - included[key].remainingPercent) * 10) / 10, resetsAt: included[key].resetsAt,
}));

// Both values belong to the same monthly credit pool; activity totals cover
// a separate reporting range and also include purchased-credit consumption.
// https://github.com/ollama/ollama/blob/f864601538bd283dbcd011244db99e2760b125c1/docs/openapi.yaml#L1089-L1111
export const includedCreditsUsed = (included: Extract<OllamaAccountUsage['included'], { kind: 'credits' }>): number =>
  included.allowanceUsd - included.balanceUsd;

export const includedCreditsHint = (included: Extract<OllamaAccountUsage['included'], { kind: 'credits' }>, t: TFunction, locale: string): string =>
  t('dashboard.upstreamEditor.ollama.usage.usedCreditsHint', { from: shortDate(included.from, locale), until: shortDate(included.until, locale) });

export const activityRangeDays = (range: string): number => {
  if (range === '24h') return 1;
  const days = /^(\d+)d$/.exec(range);
  if (days === null) throw new TypeError(`Unsupported Ollama usage range: ${range}`);
  return Number(days[1]);
};

export const activityCostHint = (activity: OllamaAccountUsage['activity'], t: TFunction, locale: string): string =>
  t(activity.scope === 'self' ? 'dashboard.upstreams.signals.costRangeSelf' : 'dashboard.upstreams.signals.costRange', { from: shortDate(activity.from, locale), until: shortDate(activity.until, locale) });

export const activityCostText = (amount: number): string =>
  `${amount < 0 ? '-' : ''}${formatUsd(parseNonNegativeDecimalString(String(Math.abs(amount))))}`;
