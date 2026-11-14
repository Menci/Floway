import { useCallback, useState } from 'react';

import { api, callApi } from '../../api/client';
import type { CopilotQuotaSnapshot } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { dateTime, shortDate } from '../../lib/format-time';
import { useLocale } from '../../lib/use-locale';
import { useUserPreferences } from '../../lib/use-preferences';
import { SECTION_STACK_CLASS } from '../ui/layout';
import { OutcomeMessageBar } from '../ui/outcome-message-bar';
import { ResourceListActions } from '../ui/resource-list';
import { SectionHeader } from '../ui/section-header';
import { useRefresh } from '../ui/use-refresh';
import { copilotQuota, copilotQuotaName, type CopilotRecord, formatBucketAmount, readBuckets, shownBuckets } from '../upstreams/copilot-quota';
import { QuotaProgressRow } from '../upstreams/quota-progress-row';

const { Text } = fluentComponents;

export function CopilotQuotaCard({ readOnly = false, record }: { readOnly?: boolean; record: CopilotRecord }) {
  const { t } = useTranslation();
  const preferences = useUserPreferences();
  const locale = useLocale();
  // A manual refresh is persisted server-side too; the local copy only avoids
  // re-fetching the record to display it. The persisted snapshot is whatever
  // source saw the seat last -- the data plane harvests one from every upstream
  // response, so it is normally current without anyone pressing anything.
  const [refreshed, setRefreshed] = useState<CopilotQuotaSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  const quota = refreshed ?? copilotQuota(record);
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
    <SectionHeader level={3} title={t('dashboard.upstreamEditor.copilot.quota.title')} actions={!readOnly &&
      <ResourceListActions
        appearance="subtle"
        onRefresh={() => void load()}
        refreshLabel={t(`dashboard.upstreamEditor.copilot.quota.${quota ? 'refresh' : 'load'}`)}
        refreshing={loading}
      />
    } />

    {buckets.map(bucket => bucket.kind === 'metered'
      ? <QuotaProgressRow
          key={bucket.id}
          label={copilotQuotaName(t, bucket.id, 'allowance')}
          percent={bucket.usedPercent}
          quotaDisplay={preferences.quotaDisplay}
          right={<Text size={200} className="text-fui-fg3 tabular-nums">
            {t('dashboard.upstreamEditor.copilot.quota.amount', {
              amount: formatBucketAmount(bucket, preferences.quotaDisplay === 'used' ? bucket.used : bucket.remaining, locale),
              entitlement: formatBucketAmount(bucket, bucket.entitlement, locale),
            })}
          </Text>}
        />
      : <div className="grid gap-1" key={bucket.id}>
          <div className="flex items-baseline justify-between gap-3">
            <Text size={300}>{copilotQuotaName(t, bucket.id, 'allowance')}</Text>
            <Text size={200} className="text-fui-fg3">{t(`dashboard.upstreamEditor.copilot.quota.${bucket.kind}`)}</Text>
          </div>
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
