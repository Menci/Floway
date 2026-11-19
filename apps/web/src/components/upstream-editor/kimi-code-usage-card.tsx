import { useCallback, useState } from 'react';

import { api, callApi } from '../../api/client';
import type { KimiCodeUsageRefresh, UpstreamRecordEnvelope } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { dateTime } from '../../lib/format-time';
import { useLocale } from '../../lib/use-locale';
import { useUserPreferences } from '../../lib/use-preferences';
import { SECTION_STACK_CLASS } from '../ui/layout';
import { OutcomeMessageBar } from '../ui/outcome-message-bar';
import { ResourceListActions } from '../ui/resource-list';
import { SectionHeader } from '../ui/section-header';
import { StatusBadge } from '../ui/status-badge';
import { useRefresh } from '../ui/use-refresh';
import { kimiCodeAccount, kimiCodeAccountName, readKimiCodeWindows, type KimiCodeRecord } from '../upstreams/kimi-code-account';
import { ProviderIcon } from '../upstreams/provider-badge';
import { QuotaProgressRow } from '../upstreams/quota-progress-row';
import { readKimiCodeUsage } from '@floway-dev/provider-kimi-code/browser';

const { Text } = fluentComponents;

export function KimiCodeUsageCard({ probeRecord, readOnly = false, record }: { probeRecord: UpstreamRecordEnvelope; readOnly?: boolean; record: KimiCodeRecord }) {
  const { t } = useTranslation();
  const preferences = useUserPreferences();
  const locale = useLocale();
  const [refreshed, setRefreshed] = useState<KimiCodeUsageRefresh | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stored = record.state?.usageProbe ?? null;
  const observation = refreshed?.observation ?? stored?.observation ?? null;
  const account = refreshed?.account?.data ?? kimiCodeAccount(record);
  const usage = observation === null ? null : readKimiCodeUsage(observation.data);
  const windows = usage === null ? [] : readKimiCodeWindows(usage);
  const backgroundError = refreshed === null ? stored?.error ?? null : null;

  const { refresh: load, refreshing: loading } = useRefresh(useCallback(async (signal: AbortSignal) => {
    setError(null);
    const { data, error: failure } = await callApi(
      () => api.api.upstreams['kimi-code'].usage.$post({ json: { record: probeRecord } }, { init: { signal } }),
    );
    if (signal.aborted) return;
    if (failure) {
      setError(failure.message);
      return;
    }
    setRefreshed(data);
  }, [probeRecord]));

  return <section className={SECTION_STACK_CLASS}>
    {account !== null && <div className="flex items-center gap-3 min-w-0">
      <ProviderIcon kind="kimi-code" className="h-8 w-8 shrink-0" />
      <Text block className="min-w-0 flex-1" weight="semibold" truncate wrap={false}>{kimiCodeAccountName(account)}</Text>
      {account.userLevelName && <StatusBadge tone="accent">{account.userLevelName}</StatusBadge>}
    </div>}
    <SectionHeader level={3} title={t('upstreams.editor.kimiCode.usage.title')} actions={!readOnly &&
      <ResourceListActions
        appearance="subtle"
        onRefresh={() => void load()}
        refreshLabel={t(`upstreams.editor.kimiCode.usage.${observation ? 'refresh' : 'load'}`)}
        refreshing={loading}
      />
    } />
    {windows.map(window => <QuotaProgressRow
      key={window.id}
      label={t(`upstreams.editor.kimiCode.usage.window.${window.id}`)}
      percent={window.percent}
      quotaDisplay={preferences.quotaDisplay}
      footer={<Text size={200} className="text-fui-fg3 tabular-nums">{t('upstreams.editor.kimiCode.usage.resets', { time: dateTime(window.resetsAt, locale) })}</Text>}
    />)}
    {usage?.monthlyCodeUsedRatio != null && <Text size={200} className="text-fui-fg2">
      {t('upstreams.editor.kimiCode.usage.monthlyCodeShare', { percent: Math.round(usage.monthlyCodeUsedRatio * 1000) / 10 })}
    </Text>}
    {observation !== null && <Text size={200} align="end" className="text-fui-fg3">{t('upstreams.editor.kimiCode.usage.updated', { time: dateTime(observation.fetchedAt, locale) })}</Text>}
    {observation === null && !loading && <Text size={200} className="text-fui-fg3">{t('upstreams.editor.kimiCode.usage.empty')}</Text>}
    {backgroundError !== null && <OutcomeMessageBar intent="warning">
      {t('upstreams.editor.kimiCode.usage.backgroundFailed', { message: backgroundError })}
    </OutcomeMessageBar>}
    {refreshed?.accountError && <OutcomeMessageBar intent="warning">
      {t('upstreams.editor.kimiCode.usage.accountFailed', { message: refreshed.accountError })}
    </OutcomeMessageBar>}
    {error && <OutcomeMessageBar onDismiss={() => setError(null)}>{error}</OutcomeMessageBar>}
  </section>;
}
