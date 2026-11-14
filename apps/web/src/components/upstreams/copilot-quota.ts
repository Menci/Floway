// Premium-interaction usage as Copilot's own client derives it:
// https://github.com/microsoft/vscode-copilot-chat/blob/5863f5a7088958050792b5dccbe8b46c6e13eccc/src/platform/chat/common/chatQuotaServiceImpl.ts#L83-L120

import type { CopilotQuotaSnapshot, UpstreamRecord } from '../../api/types';
import type { TFunction } from '../../i18n/translation';
import { formatUsdNumber } from '../../lib/decimal-display';
import { copilotCreditsToUsd, isCopilotCreditQuota } from '@floway-dev/provider-copilot/browser';

export type CopilotRecord = Extract<UpstreamRecord, { kind: 'copilot' }>;

type BucketKind = 'metered' | 'unlimited' | 'unavailable';

export interface QuotaBucket {
  id: string;
  kind: BucketKind;
  // Credit buckets are metered in GitHub AI Credits and shown in dollars.
  credits: boolean;
  entitlement: number;
  remaining: number;
  used: number;
  usedPercent: number;
}

// A free seat reports `entitlement: 0` with `percent_remaining: 0`, which as
// metered would render a full bar on a seat with no premium allotment.
// `usedPercent` stays as upstream computed it, past 100 for an overage-
// permitted bucket; the row clamps what it paints.
export const readBuckets = (quota: CopilotQuotaSnapshot | null): QuotaBucket[] =>
  Object.entries(quota?.quotas ?? {}).map(([id, detail]) => {
    const usedPercent = Math.round(100 - detail.percent_remaining);
    return {
      id,
      kind: detail.unlimited ? 'unlimited' : detail.entitlement > 0 ? 'metered' : 'unavailable',
      credits: isCopilotCreditQuota(id),
      entitlement: detail.entitlement,
      remaining: isCopilotCreditQuota(id) ? detail.quota_remaining : Math.round(detail.quota_remaining),
      used: isCopilotCreditQuota(id) ? detail.entitlement - detail.quota_remaining : Math.round(detail.entitlement - detail.quota_remaining),
      usedPercent,
    };
  });

// A seat with nothing metered still gets one row, so the card does not read as
// "no quota observed" when the truth is "nothing is capped". The unnamed
// fallback survives GitHub renaming the premium bucket.
export const shownBuckets = (buckets: QuotaBucket[]): QuotaBucket[] => {
  const metered = buckets.filter(bucket => bucket.kind === 'metered');
  if (metered.length > 0) return metered;
  const standIn = buckets.find(bucket => bucket.id.startsWith('premium')) ?? buckets[0];
  return standIn === undefined ? [] : [standIn];
};

export const copilotQuota = (record: CopilotRecord): CopilotQuotaSnapshot | null =>
  record.state?.quotaSnapshot?.data ?? null;

export const formatBucketAmount = (bucket: QuotaBucket, amount: number, locale: string): string =>
  bucket.credits
    ? formatUsdNumber(copilotCreditsToUsd(amount), locale)
    : new Intl.NumberFormat(locale).format(amount);

// The id is an open string GitHub owns, so one this table does not know is shown
// as the id itself rather than rewritten.
export const copilotQuotaName = (t: TFunction, id: string, quantity: 'allowance' | 'remaining' | 'usage'): string => {
  switch (id) {
  case 'premium_interactions': return t(`dashboard.upstreams.copilotQuota.premiumInteractions.${quantity}`);
  case 'chat': return t(`dashboard.upstreams.copilotQuota.chat.${quantity}`);
  case 'completions': return t(`dashboard.upstreams.copilotQuota.completions.${quantity}`);
  default: return t(`dashboard.upstreams.copilotQuota.other.${quantity}`, { name: id });
  }
};
