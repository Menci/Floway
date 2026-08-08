// What an upstream reports about itself beyond its identity: the live readings
// its own provider decides are worth a glance from the list, without opening
// the editor. Each provider contributes what its upstream actually publishes,
// so an upstream with nothing to report contributes nothing and its row stays
// one line high.

import { findCredential, quotaWindows, WINDOW_MINUTES } from './claude-code-account';
import { latestCredits, latestQuotaEntry, quotaEntries } from './codex-account';
import { copilotQuota, readBuckets, shownBuckets } from './copilot-quota';
import { activityCostText, readActivityCost, readWindows } from './ollama-usage';
import { quotaRingTone, WALL_CLOCK_REFRESH_MS, windowLengthLabel } from './subscription-quota';
import type { UpstreamRecord } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { type TFunction, useTranslation } from '../../i18n/translation';
import { dateTime } from '../../lib/format-time';
import { useLocale } from '../../lib/use-locale';
import { useNow } from '../../lib/use-now';
import { ProgressRing } from '../ui/progress-ring';

const { Text, Tooltip } = fluentComponents;

interface Meter {
  kind: 'meter';
  key: string;
  label: string;
  /** As the upstream reported it: an overage-permitted bucket runs past 100. */
  percent: number;
  detail: string;
}

interface Amount {
  kind: 'amount';
  key: string;
  text: string;
  detail: string;
}

export type UpstreamSignal = Meter | Amount;

// The tooltip carries what the row has no width for -- the window's own name,
// when it resets, when the reading was taken -- as one line, because a Fluent
// tooltip renders its content as a single run of text.
const detailText = (parts: (string | null)[]): string => parts.filter(part => part !== null).join(' - ');

const meterDetail = (t: TFunction, label: string, percent: number, resetAt: string | null, observedAt: string | number | null, locale: string): string =>
  detailText([
    t('dashboard.upstreams.signals.used', { label, percent: Math.round(percent) }),
    resetAt === null ? null : t('dashboard.upstreams.signals.resets', { time: dateTime(resetAt, locale) }),
    observedAt === null ? null : t('dashboard.upstreams.signals.observed', { time: dateTime(observedAt, locale) }),
  ]);

const copilotSignals = (record: Extract<UpstreamRecord, { kind: 'copilot' }>, t: TFunction, locale: string): UpstreamSignal[] => {
  const quota = copilotQuota(record);
  if (quota === null) return [];
  // The bucket id is an open string GitHub owns, so it reaches the row as the
  // name it arrived under rather than through a table this dashboard maintains.
  return shownBuckets(readBuckets(quota))
    .filter(bucket => bucket.kind === 'metered')
    .map(bucket => ({
      kind: 'meter' as const,
      key: bucket.id,
      label: bucket.label,
      percent: bucket.usedPercent,
      detail: meterDetail(t, bucket.label, bucket.usedPercent, quota.reset_at ?? null, quota.observed_at, locale),
    }));
};

const codexSignals = (record: Extract<UpstreamRecord, { kind: 'codex' }>, t: TFunction, locale: string, now: number): UpstreamSignal[] => {
  const entry = latestQuotaEntry(quotaEntries(record.codex_quota, now));
  const credits = latestCredits(record.codex_quota);
  const signals: UpstreamSignal[] = entry === null ? [] : entry.windows.map(item => {
    // Codex states each window's length in minutes and nothing else names it,
    // so an unlabelled window falls back to the position it arrived in.
    const label = item.windowMinutes === null
      ? t(`dashboard.upstreams.signals.window.${item.key}`)
      : windowLengthLabel(item.windowMinutes);
    return {
      kind: 'meter' as const,
      key: item.key,
      label,
      percent: item.percent,
      detail: meterDetail(t, label, item.percent, item.resetAt, entry.observedAt, locale),
    };
  });

  if (credits?.credits_has_credits === false) {
    signals.push({
      kind: 'amount',
      key: 'credits',
      text: t('dashboard.upstreams.signals.noCredits'),
      detail: t('dashboard.upstreams.signals.creditsDetail'),
    });
  } else if (credits?.credits_balance !== undefined) {
    signals.push({
      kind: 'amount',
      key: 'credits',
      text: t('dashboard.upstreams.signals.credits', { balance: credits.credits_balance }),
      detail: t('dashboard.upstreams.signals.creditsDetail'),
    });
  }
  return signals;
};

const claudeCodeSignals = (record: Extract<UpstreamRecord, { kind: 'claude-code' }>, t: TFunction, locale: string): UpstreamSignal[] => {
  const lookup = findCredential(record);
  return quotaWindows(lookup.kind === 'present' ? lookup.credential : null).map(row => {
    const length = windowLengthLabel(WINDOW_MINUTES[row.key]);
    // Anthropic reports the Sonnet allowance as a second window of the same
    // length, so the model it covers is what tells the two apart.
    const label = row.key === 'sevenDaySonnet' ? `${length} Sonnet` : length;
    return {
      kind: 'meter' as const,
      key: row.key,
      label,
      percent: row.percent,
      detail: meterDetail(t, label, row.percent, row.resetAt, row.fetchedAt, locale),
    };
  });
};

const ollamaSignals = (record: Extract<UpstreamRecord, { kind: 'ollama' }>, t: TFunction, locale: string): UpstreamSignal[] => {
  const probe = record.state?.usageProbe ?? null;
  const observation = probe?.observation ?? null;
  if (observation === null) return [];

  const signals: UpstreamSignal[] = readWindows(observation.data).map(item => {
    const label = windowLengthLabel(item.minutes);
    return {
      kind: 'meter' as const,
      key: item.key,
      label,
      // Ollama reports no reset instant for either window.
      detail: meterDetail(t, label, item.percent, null, observation.fetchedAt, locale),
      percent: item.percent,
    };
  });

  const cost = readActivityCost(observation.data);
  if (cost !== null) {
    signals.push({
      kind: 'amount',
      key: 'cost',
      text: activityCostText(cost),
      detail: t('dashboard.upstreams.signals.costDetail'),
    });
  }
  return signals;
};

export const upstreamSignals = (record: UpstreamRecord, t: TFunction, locale: string, now: number): UpstreamSignal[] => {
  switch (record.kind) {
  // An operator-configured endpoint publishes no account of its own to report on.
  case 'custom':
  case 'azure':
    return [];
  case 'copilot': return copilotSignals(record, t, locale);
  case 'codex': return codexSignals(record, t, locale, now);
  case 'claude-code': return claudeCodeSignals(record, t, locale);
  case 'ollama': return ollamaSignals(record, t, locale);
  }
};

export function UpstreamSignals({ record }: { record: UpstreamRecord }) {
  const { t } = useTranslation();
  const locale = useLocale();
  // Codex drops a rate-limit window once it has expired, which is a change on
  // the wall clock rather than in the record.
  const now = useNow(WALL_CLOCK_REFRESH_MS);
  const signals = upstreamSignals(record, t, locale, now);
  if (signals.length === 0) return null;

  return <div className="flex items-center gap-x-3 min-w-0">
    {signals.map(signal => <Tooltip content={signal.detail} key={signal.key} relationship="description">
      <span className="winui-focus-rect inline-flex items-center gap-1 min-w-0" tabIndex={0}>
        {signal.kind === 'meter' && <ProgressRing percent={signal.percent} tone={quotaRingTone(signal.percent)} />}
        <Text size={200} className="text-fui-fg2" truncate wrap={false}>
          {signal.kind === 'meter'
            ? t('dashboard.upstreams.signals.meter', { label: signal.label, percent: Math.round(signal.percent) })
            : signal.text}
        </Text>
      </span>
    </Tooltip>)}
  </div>;
}
