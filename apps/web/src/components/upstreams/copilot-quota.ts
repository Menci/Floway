// Premium-interaction usage as Copilot's own client derives it:
// https://github.com/microsoft/vscode-copilot-chat/blob/5863f5a7088958050792b5dccbe8b46c6e13eccc/src/platform/chat/common/chatQuotaServiceImpl.ts#L83-L120

import type { CopilotQuotaSnapshot, UpstreamRecord } from '../../api/types';
import { clampPercent } from '../../lib/percent';

export type CopilotRecord = Extract<UpstreamRecord, { kind: 'copilot' }>;

type BucketKind = 'metered' | 'unlimited' | 'unavailable';

export interface QuotaBucket {
  id: string;
  label: string;
  kind: BucketKind;
  entitlement: number;
  used: number;
  usedPercent: number;
  barPercent: number | null;
}

// A free seat reports `entitlement: 0` with `percent_remaining: 0`, which as
// metered would render a full bar on a seat with no premium allotment.
// `usedPercent` stays as upstream computed it, past 100 for an overage-
// permitted bucket; only the bar is clamped.
export const readBuckets = (quota: CopilotQuotaSnapshot | null): QuotaBucket[] =>
  Object.entries(quota?.quotas ?? {}).map(([id, detail]) => {
    const usedPercent = Math.round(100 - detail.percent_remaining);
    return {
      id,
      label: id.replace(/_/g, ' '),
      kind: detail.unlimited ? 'unlimited' : detail.entitlement > 0 ? 'metered' : 'unavailable',
      entitlement: detail.entitlement,
      used: Math.round(detail.entitlement - detail.quota_remaining),
      usedPercent,
      barPercent: clampPercent(usedPercent),
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
