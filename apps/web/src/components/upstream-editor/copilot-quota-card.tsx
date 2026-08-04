import { useCallback, useState } from 'react';

import { quotaBarColor } from './subscription-account-quota';
import { api, callApi } from '../../api/client';
import type { CopilotQuotaSnapshot, UpstreamRecord } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { dateTime, shortDate } from '../../lib/format-time';
import { clampPercent } from '../../lib/percent';
import { useLocale } from '../../lib/use-locale';
import { SECTION_STACK_CLASS } from '../ui/layout';
import { OutcomeMessageBar } from '../ui/outcome-message-bar';
import { ResourceListActions } from '../ui/resource-list';
import { SectionHeader } from '../ui/section-header';
import { useRefresh } from '../ui/use-refresh';

const { ProgressBar, Text } = fluentComponents;

type CopilotRecord = Extract<UpstreamRecord, { kind: 'copilot' }>;

type BucketKind = 'metered' | 'unlimited' | 'unavailable';

interface QuotaBucket {
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
const readBuckets = (quota: CopilotQuotaSnapshot | null): QuotaBucket[] =>
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
const shownBuckets = (buckets: QuotaBucket[]): QuotaBucket[] => {
  const metered = buckets.filter(bucket => bucket.kind === 'metered');
  if (metered.length > 0) return metered;
  const standIn = buckets.find(bucket => bucket.id.startsWith('premium')) ?? buckets[0];
  return standIn === undefined ? [] : [standIn];
};

// Premium-interaction usage as Copilot's own client derives it:
// https://github.com/microsoft/vscode-copilot-chat/blob/5863f5a7088958050792b5dccbe8b46c6e13eccc/src/platform/chat/common/chatQuotaServiceImpl.ts#L83-L120
export function CopilotQuotaCard({ record }: { record: CopilotRecord }) {
  const { t } = useTranslation();
  const locale = useLocale();
  // A manual refresh is persisted server-side too; the local copy only avoids
  // re-fetching the record to display it. The persisted snapshot is whatever
  // source saw the seat last -- the data plane harvests one from every upstream
  // response, so it is normally current without anyone pressing anything.
  const [refreshed, setRefreshed] = useState<CopilotQuotaSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  const quota = refreshed ?? record.state?.quotaSnapshot?.data ?? null;
  const buckets = shownBuckets(readBuckets(quota));

  const { refresh: load, refreshing: loading } = useRefresh(useCallback(async (signal: AbortSignal) => {
    setError(null);
    const { data, error: failure } = await callApi(
      () => api.api.upstreams.copilot.quota.$post(
        { json: { record: { id: record.id, kind: 'copilot', config: record.config, state: record.state ?? null } } },
        { init: { signal } },
      ),
    );
    if (signal.aborted) return;
    if (failure) {
      setError(failure.message);
      return;
    }
    setRefreshed(data ?? null);
  }, [record]));

  // `reset_at` is an instant, but always a day boundary.
  const resets = quota?.reset_at == null ? null : shortDate(quota.reset_at, locale);

  return <section className={SECTION_STACK_CLASS}>
    <SectionHeader level={3} title={t('dashboard.upstreamEditor.copilot.quota.title')} actions={
      <ResourceListActions
        appearance="subtle"
        onRefresh={() => void load()}
        refreshLabel={t(`dashboard.upstreamEditor.copilot.quota.${quota ? 'refresh' : 'load'}`)}
        refreshing={loading}
      />
    } />

    {buckets.map(bucket => <div className="grid gap-1" key={bucket.id}>
      <div className="flex items-baseline justify-between gap-3">
        <Text className="capitalize" size={300}>{bucket.label}</Text>
        {bucket.kind === 'metered'
          ? <div className="flex items-baseline gap-2">
              <Text size={200} className="text-fui-fg2">
                {t('dashboard.upstreamEditor.copilot.quota.used', {
                  used: bucket.used,
                  entitlement: bucket.entitlement,
                })}
              </Text>
              <Text size={200} className="text-fui-fg3">
                {t('dashboard.upstreamEditor.copilot.quota.usedPercent', { percent: bucket.usedPercent })}
              </Text>
            </div>
          : <Text size={200} className="text-fui-fg3">
              {t(`dashboard.upstreamEditor.copilot.quota.${bucket.kind}`)}
            </Text>}
      </div>
      {bucket.kind === 'metered' && <ProgressBar color={quotaBarColor(bucket.barPercent)} max={100} thickness="large" value={bucket.barPercent ?? undefined} />}
    </div>)}

    {/* The reset date leads because a narrow row stacks these two, and alone on
        a line it is the one worth reading first. */}
    {quota && <div className="flex flex-wrap items-baseline justify-between gap-x-3">
      {resets !== null && <Text size={200} className="text-fui-fg3">
        {t('dashboard.upstreamEditor.copilot.quota.resets', { date: resets })}
      </Text>}
      <Text size={200} className="text-fui-fg3">
        {t('dashboard.upstreamEditor.copilot.quota.observed', { time: dateTime(quota.observed_at, locale) })}
      </Text>
    </div>}

    {!quota && !loading && <Text size={200} className="text-fui-fg3">{t('dashboard.upstreamEditor.copilot.quota.empty')}</Text>}

    {error && <OutcomeMessageBar onDismiss={() => setError(null)}>{error}</OutcomeMessageBar>}
  </section>;
}
