import { useCallback, useState } from 'react';

import { api, callApi } from '../../api/client';
import type { OllamaUsageRefresh, UpstreamRecordEnvelope } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { dateTime } from '../../lib/format-time';
import { clampPercent } from '../../lib/percent';
import { useLocale } from '../../lib/use-locale';
import { SECTION_STACK_CLASS } from '../ui/layout';
import { OutcomeMessageBar } from '../ui/outcome-message-bar';
import { ResourceListActions } from '../ui/resource-list';
import { SectionHeader } from '../ui/section-header';
import { StatusBadge } from '../ui/status-badge';
import { useRefresh } from '../ui/use-refresh';
import { activityCostHint, activityCostText, activityRangeDays, type OllamaRecord, readWindows } from '../upstreams/ollama-usage';
import { ProviderIcon } from '../upstreams/provider-badge';
import { quotaBarColor } from '../upstreams/subscription-quota';
import { readOllamaAccountUsage } from '@floway-dev/provider-ollama/browser';

const { InfoLabel, ProgressBar, Text } = fluentComponents;

export function OllamaUsageCard({ probeRecord, record }: { probeRecord: UpstreamRecordEnvelope; record: OllamaRecord }) {
  const { t } = useTranslation();
  const locale = useLocale();
  // A manual refresh persists server-side too; this local copy only avoids
  // re-fetching the whole record to display the reading it just produced.
  const [refreshed, setRefreshed] = useState<OllamaUsageRefresh | null>(null);
  const [error, setError] = useState<string | null>(null);

  const stored = record.state?.usageProbe ?? null;
  const observation = refreshed?.observation ?? stored?.observation ?? null;
  const account = refreshed?.account ?? record.state?.account ?? null;
  const usage = observation === null ? null : readOllamaAccountUsage(observation.data);
  const windows = usage === null ? [] : readWindows(usage.included);
  const backgroundError = refreshed === null ? stored?.error ?? null : null;
  const accountName = account?.name ?? account?.email ?? null;

  const { refresh: load, refreshing: loading } = useRefresh(useCallback(async (signal: AbortSignal) => {
    setError(null);
    const { data, error: failure } = await callApi(
      () => api.api.upstreams.ollama.usage.$post({ json: { record: probeRecord } }, { init: { signal } }),
    );
    if (signal.aborted) return;
    if (failure) {
      setError(failure.message);
      return;
    }
    setRefreshed(data);
  }, [probeRecord]));

  return <section className={SECTION_STACK_CLASS}>
    {accountName !== null && <div className="flex items-center gap-3 min-w-0">
      <ProviderIcon kind="ollama" className="h-8 w-8 shrink-0" />
      <div className="grid gap-0.5 min-w-0 flex-1">
        <Text block weight="semibold" truncate wrap={false}>{accountName}</Text>
        {account?.email && account.name && <Text block size={200} className="text-fui-fg2" truncate wrap={false}>{account.email}</Text>}
      </div>
      {/* Ollama's own word for the tier, shown as it arrives. */}
      {account?.plan && <StatusBadge tone="accent" className="capitalize">{account.plan}</StatusBadge>}
    </div>}

    <SectionHeader level={3} title={t('dashboard.upstreamEditor.ollama.usage.title')} actions={
      <ResourceListActions
        appearance="subtle"
        onRefresh={() => void load()}
        refreshLabel={t(`dashboard.upstreamEditor.ollama.usage.${observation ? 'refresh' : 'load'}`)}
        refreshing={loading}
      />
    } />

    {usage?.included.kind === 'credits' && <div className="grid gap-1">
      <div className="flex items-baseline justify-between gap-3">
        <InfoLabel info={t('dashboard.upstreamEditor.ollama.usage.balanceHint.included')}>{t('dashboard.upstreamEditor.ollama.usage.balance.included')}</InfoLabel>
        <Text>{activityCostText(usage.included.balanceUsd)}</Text>
      </div>
      <div className="flex flex-wrap justify-between gap-x-3">
        <Text size={200} className="text-fui-fg3">{t('dashboard.upstreamEditor.ollama.usage.allowance', { amount: activityCostText(usage.included.allowanceUsd) })}</Text>
        <Text size={200} className="text-fui-fg3">{t('dashboard.upstreamEditor.ollama.usage.resets', { time: dateTime(usage.included.until, locale) })}</Text>
      </div>
    </div>}

    {windows.map(usageWindow => <div className="grid gap-1" key={usageWindow.key}>
      <div className="flex items-baseline justify-between gap-3">
        <Text size={300}>{t(`dashboard.upstreamEditor.ollama.usage.window.${usageWindow.key}`)}</Text>
        <Text size={200} className="text-fui-fg2">
          {t('dashboard.upstreamEditor.ollama.usage.remainingPercent', { percent: 100 - usageWindow.percent })}
        </Text>
      </div>
      {/* This is a remaining-quota bar, like a health bar, not usage progress, so its fill is 100 - used percent. */}
      <ProgressBar
        color={quotaBarColor(usageWindow.percent)}
        max={100}
        thickness="large"
        value={clampPercent(100 - usageWindow.percent) ?? undefined}
      />
      <Text size={200} className="text-fui-fg3">{t('dashboard.upstreamEditor.ollama.usage.resets', { time: dateTime(usageWindow.resetsAt, locale) })}</Text>
    </div>)}

    {usage !== null && <div className="flex justify-between gap-3">
      <InfoLabel info={t('dashboard.upstreamEditor.ollama.usage.balanceHint.purchased')}>{t('dashboard.upstreamEditor.ollama.usage.balance.purchased')}</InfoLabel>
      <Text>{activityCostText(usage.purchasedBalanceUsd)}</Text>
    </div>}

    {usage?.activity.usageUsd != null && <div className="flex justify-between gap-3">
      <InfoLabel info={activityCostHint(usage.activity, t, locale)}>{t('dashboard.upstreamEditor.ollama.usage.recentUsage', { count: activityRangeDays(usage.activity.range) })}</InfoLabel>
      <Text>{activityCostText(usage.activity.usageUsd)}</Text>
    </div>}

    {observation !== null && <Text size={200} align="end" className="text-fui-fg3">{t('dashboard.upstreamEditor.ollama.usage.observed', { time: dateTime(observation.fetchedAt, locale) })}</Text>}

    {!observation && !loading && <Text size={200} className="text-fui-fg3">{t('dashboard.upstreamEditor.ollama.usage.empty')}</Text>}

    {backgroundError !== null && <OutcomeMessageBar intent="warning">
      {t('dashboard.upstreamEditor.ollama.usage.backgroundFailed', { message: backgroundError })}
    </OutcomeMessageBar>}

    {error && <OutcomeMessageBar onDismiss={() => setError(null)}>{error}</OutcomeMessageBar>}
  </section>;
}
