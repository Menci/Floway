import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api, callApi } from '../../api/client';
import type { CopilotQuotaSnapshot, UpstreamRecord } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { formatCount } from '../../lib/format-number';
import { dateTime, shortDate } from '../../lib/format-time';
import { useLocale } from '../../lib/use-locale';
import { OutcomeMessageBar } from '../ui/outcome-message-bar';
import { ResourceListActions } from '../ui/resource-list';
import { SectionHeader } from '../ui/section-header';

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
  barPercent: number;
}

// Every bucket the seat reports, in the upstream's own naming, sorted into the
// three kinds a seat actually reports. A paid seat meters
// `premium_interactions` (or `premium_models`) and reports `chat` /
// `completions` as unlimited; a free seat meters the latter two and reports
// `premium_interactions` as unavailable — `entitlement: 0`, which the upstream
// pairs with `percent_remaining: 0`, so treating it as a metered bucket would
// render a full bar on a seat that simply has no premium allotment.
//
// `usedPercent` is reported as the upstream computed it, including past 100
// when an overage-permitted bucket runs negative. Only the bar is clamped,
// because a bar cannot be wider than itself.
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
      barPercent: Math.min(100, Math.max(0, usedPercent)),
    };
  });

// Only metered buckets carry information, so they are the card. A seat with
// nothing metered still gets one row — otherwise the card would read as "no
// quota observed" when the truth is "nothing is capped". The premium bucket is
// the one an operator looks for, so it is the preferred stand-in; falling back
// to the first reported bucket keeps that working if GitHub renames it.
const shownBuckets = (buckets: QuotaBucket[]): QuotaBucket[] => {
  const metered = buckets.filter(bucket => bucket.kind === 'metered');
  if (metered.length > 0) return metered;
  const standIn = buckets.find(bucket => bucket.id.startsWith('premium')) ?? buckets[0];
  return standIn === undefined ? [] : [standIn];
};

// Copilot's own client derives premium-interaction usage from the on-demand
// `copilot_internal/user` snapshot:
// https://github.com/microsoft/vscode-copilot-chat/blob/5863f5a7088958050792b5dccbe8b46c6e13eccc/src/platform/chat/common/chatQuotaServiceImpl.ts#L83-L120
export function CopilotQuotaCard({ record }: { record: CopilotRecord }) {
  const { t } = useTranslation();
  const locale = useLocale();
  // The persisted snapshot is whatever source saw the seat last — the data
  // plane harvests one from every upstream response, so it is normally current
  // without anyone pressing anything. A manual refresh returns the same shape
  // and is persisted server-side too; holding the reply locally just avoids
  // re-fetching the record to display it.
  const [refreshed, setRefreshed] = useState<CopilotQuotaSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const quota = refreshed ?? record.state?.quotaSnapshot?.data ?? null;
  const buckets = shownBuckets(readBuckets(quota));

  const load = async () => {
    setLoading(true);
    setError(null);
    const { data, error: failure } = await callApi(
      () => api.api.upstreams.copilot.quota.$post({ json: { record: { id: record.id, kind: 'copilot', config: record.config, state: record.state ?? null } } }),
    );
    setLoading(false);
    if (failure) {
      setError(failure.message);
      return;
    }
    setRefreshed(data ?? null);
  };

  // `reset_at` is an instant, but it is always a day boundary and nobody plans
  // against its clock time, so it renders as the local calendar date it falls
  // on -- through `shortDate`, because that date is spelled `Sep 1, 2026` in
  // `en` and `2026年9月1日` in `zh-Hans`.
  const resets = quota?.reset_at == null ? null : shortDate(quota.reset_at, locale);

  return <section className="grid gap-2">
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
          // The percentage is the fraction divided out, and the bar below states
          // it a third time in ink, so it reads as the gloss on the two exact
          // numbers rather than as a second fact beside them. Ranking the two by
          // colour is what lets the space between them separate them.
          ? <div className="flex items-baseline gap-2">
              <Text size={200} className="text-fui-fg2">
                {t('dashboard.upstreamEditor.copilot.quota.used', {
                  used: formatCount(bucket.used, locale),
                  entitlement: formatCount(bucket.entitlement, locale),
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
      {bucket.kind === 'metered' && <ProgressBar max={100} thickness="large" value={bucket.barPercent} />}
    </div>)}

    {/* Two independent facts about the snapshot rather than one phrase, so they
        take the row's own two ends -- the same left-label/right-value split the
        bucket rows above use. Narrow enough and they stack, which is why the
        reset date leads: alone on a line it is the one worth reading first. */}
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
