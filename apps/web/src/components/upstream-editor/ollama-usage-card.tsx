// Ollama Cloud account usage. The windows are percentages with no reset
// timestamp — that is everything the upstream reports — so each row is a bar
// and a number.
//
// The data plane refreshes the same reading in the background after the calls
// it serves, so this card is normally current on open; the refresh action is
// the operator's unconditional read.

import { useCallback, useState } from 'react';

import { api, callApi } from '../../api/client';
import type { OllamaUsageObservation, UpstreamRecordEnvelope } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { dateTime } from '../../lib/format-time';
import { clampPercent } from '../../lib/percent';
import { useLocale } from '../../lib/use-locale';
import { SECTION_STACK_CLASS } from '../ui/layout';
import { OutcomeMessageBar } from '../ui/outcome-message-bar';
import { ResourceListActions } from '../ui/resource-list';
import { SectionHeader } from '../ui/section-header';
import { useRefresh } from '../ui/use-refresh';
import { activityCostText, type OllamaRecord, readActivityCost, readWindows } from '../upstreams/ollama-usage';
import { quotaBarColor } from '../upstreams/subscription-quota';

const { ProgressBar, Text } = fluentComponents;

export function OllamaUsageCard({ probeRecord, record }: { probeRecord: UpstreamRecordEnvelope; record: OllamaRecord }) {
  const { t } = useTranslation();
  const locale = useLocale();
  // A manual refresh persists server-side too; this local copy only avoids
  // re-fetching the whole record to display the reading it just produced.
  const [refreshed, setRefreshed] = useState<OllamaUsageObservation | null>(null);
  const [error, setError] = useState<string | null>(null);

  const stored = record.state?.usageProbe ?? null;
  const observation = refreshed ?? stored?.observation ?? null;
  const windows = readWindows(observation?.data);
  const activityCost = readActivityCost(observation?.data);
  // A background probe records its failure on the upstream rather than
  // interrupting the request that armed it, so this is where it surfaces. A
  // manual refresh that succeeded has already answered the question.
  const backgroundError = refreshed === null ? stored?.error ?? null : null;

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
    <SectionHeader level={3} title={t('dashboard.upstreamEditor.ollama.usage.title')} actions={
      <ResourceListActions
        appearance="subtle"
        onRefresh={() => void load()}
        refreshLabel={t(`dashboard.upstreamEditor.ollama.usage.${observation ? 'refresh' : 'load'}`)}
        refreshing={loading}
      />
    } />

    {windows.map(usageWindow => <div className="grid gap-1" key={usageWindow.key}>
      <div className="flex items-baseline justify-between gap-3">
        <Text size={300}>{t(`dashboard.upstreamEditor.ollama.usage.window.${usageWindow.key}`)}</Text>
        <Text size={200} className="text-fui-fg2">
          {t('dashboard.upstreamEditor.ollama.usage.usedPercent', { percent: usageWindow.percent })}
        </Text>
      </div>
      <ProgressBar color={quotaBarColor(usageWindow.percent)} max={100} thickness="large" value={clampPercent(usageWindow.percent) ?? undefined} />
    </div>)}

    {observation && <div className="flex flex-wrap items-baseline justify-between gap-x-3">
      {activityCost !== null && <Text size={200} className="text-fui-fg3">{activityCostText(activityCost)}</Text>}
      <Text size={200} className="text-fui-fg3">
        {t('dashboard.upstreamEditor.ollama.usage.observed', { time: dateTime(observation.fetchedAt, locale) })}
      </Text>
    </div>}

    {observation && windows.length === 0 && <Text size={200} className="text-fui-fg3">
      {t('dashboard.upstreamEditor.ollama.usage.unreadable')}
    </Text>}

    {!observation && !loading && <Text size={200} className="text-fui-fg3">
      {t('dashboard.upstreamEditor.ollama.usage.empty')}
    </Text>}

    {backgroundError !== null && <OutcomeMessageBar intent="warning">
      {t('dashboard.upstreamEditor.ollama.usage.backgroundFailed', { message: backgroundError })}
    </OutcomeMessageBar>}

    {error && <OutcomeMessageBar onDismiss={() => setError(null)}>{error}</OutcomeMessageBar>}
  </section>;
}
