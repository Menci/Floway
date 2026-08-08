// Ollama Cloud account usage. The windows are percentages with no reset
// timestamp — that is everything the upstream reports — so each row is a bar
// and a number, and the per-model request counts sit under them as the only
// breakdown available.
//
// The data plane refreshes the same reading in the background after the calls
// it serves, so this card is normally current on open; the refresh action is
// the operator's unconditional read.

import { useCallback, useState } from 'react';

import { quotaBarColor } from './subscription-account-quota';
import { api, callApi } from '../../api/client';
import type { OllamaUsageObservation, UpstreamRecordEnvelope, UpstreamRecord } from '../../api/types';
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

const { ProgressBar, Text } = fluentComponents;

type OllamaRecord = Extract<UpstreamRecord, { kind: 'ollama' }>;

// Usage is an ollama.com account fact; a self-hosted daemon serves no such
// endpoint. The gateway rejects the call on the same grounds, so this only
// decides whether the card is worth offering.
export const isOllamaCloudBaseUrl = (baseUrl: string): boolean => {
  try {
    return new URL(baseUrl).hostname === 'ollama.com';
  } catch {
    // A half-typed URL in the form field is not a cloud endpoint yet.
    return false;
  }
};

interface UsageWindow {
  key: 'session' | 'weekly';
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
  return { key, percent: Math.round(value.usage * 1000) / 10 };
};

const readWindows = (data: unknown): UsageWindow[] => {
  const limits = isRecordValue(data) ? data.limits : null;
  if (!isRecordValue(limits)) return [];
  return [readWindow('session', limits.session), readWindow('weekly', limits.weekly)]
    .filter((usageWindow): usageWindow is UsageWindow => usageWindow !== null);
};

// `activity.cost` over a trailing period, reported as a plain decimal string
// in USD. It carries no label of its own: the upstream states nowhere what the
// figure covers, and a currency amount on a usage card says what it is. An
// account that has spent nothing still reports "0.00000", which is worth
// showing: it is the difference between zero and not reported.
const readActivityCost = (data: unknown): string | null => {
  const activity = isRecordValue(data) ? data.activity : null;
  if (!isRecordValue(activity) || typeof activity.cost !== 'string') return null;
  return activity.cost;
};

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
      {activityCost !== null && <Text size={200} className="text-fui-fg3">{`$${activityCost}`}</Text>}
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
