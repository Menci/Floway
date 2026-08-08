// What an upstream reports about itself beyond its identity: the live readings
// its own provider decides are worth a glance from the list, without opening
// the editor. Each provider contributes what its upstream actually publishes,
// so an upstream with nothing to report contributes nothing and its row stays
// one line high.

import { findCredential, planLabel as claudeCodePlanLabel, quotaWindows, WINDOW_MINUTES } from './claude-code-account';
import { latestCredits, latestQuotaEntry, planLabel as codexPlanLabel, quotaEntries } from './codex-account';
import { copilotQuota, readBuckets, shownBuckets } from './copilot-quota';
import { planLabel as ollamaPlanLabel } from './ollama-account';
import { activityCostText, readActivityCost, readWindows } from './ollama-usage';
import { providerLabel } from './provider-badge';
import { quotaRingTone, WALL_CLOCK_REFRESH_MS, windowLengthLabel } from './subscription-quota';
import type { UpstreamRecord } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { type TFunction, useTranslation } from '../../i18n/translation';
import { dateTime, shortDate } from '../../lib/format-time';
import { useLocale } from '../../lib/use-locale';
import { useNow } from '../../lib/use-now';
import { ProgressRing } from '../ui/progress-ring';

const { Text, Tooltip } = fluentComponents;

// One signal is a reading and what the reading is of: a percentage of a window,
// or an amount that stands alone. The reading leads, because a row of them is
// scanned down the numbers.
export interface UpstreamSignal {
  key: string;
  /** A percentage this reading fills a ring with, or null for an amount. */
  percent: number | null;
  value: string;
  label: string | null;
  detail: string;
}

// What the upstream connects as: the subscription when it names one, and the
// provider itself when it does not, so every row's second line opens with the
// same kind of fact and no row is blank.
export interface UpstreamReadout {
  plan: string;
  signals: UpstreamSignal[];
}

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

// As the upstream reported it: an overage-permitted bucket runs past 100, and
// only the ring beside the number is clamped.
const percentValue = (t: TFunction, percent: number): string =>
  t('dashboard.upstreams.signals.percent', { percent: Math.round(percent) });

const copilotSignals = (record: Extract<UpstreamRecord, { kind: 'copilot' }>, t: TFunction, locale: string): UpstreamSignal[] => {
  const quota = copilotQuota(record);
  if (quota === null) return [];
  // A seat's buckets all reset together, so the date says more in the row than
  // the bucket's own name would; the name stays in the tooltip. The id is an
  // open string GitHub owns and is never rewritten into a table of ours.
  return shownBuckets(readBuckets(quota))
    .filter(bucket => bucket.kind === 'metered')
    .map(bucket => ({
      key: bucket.id,
      percent: bucket.usedPercent,
      value: percentValue(t, bucket.usedPercent),
      label: quota.reset_at == null ? null : t('dashboard.upstreams.signals.until', { date: shortDate(quota.reset_at, locale) }),
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
      key: item.key,
      percent: item.percent,
      value: percentValue(t, item.percent),
      label,
      detail: meterDetail(t, label, item.percent, item.resetAt, entry.observedAt, locale),
    };
  });

  if (credits?.credits_has_credits === false) {
    signals.push({
      key: 'credits',
      percent: null,
      value: t('dashboard.upstreams.signals.noCredits'),
      label: null,
      detail: t('dashboard.upstreams.signals.creditsDetail'),
    });
  } else if (credits?.credits_balance !== undefined) {
    signals.push({
      key: 'credits',
      percent: null,
      value: t('dashboard.upstreams.signals.credits', { balance: credits.credits_balance }),
      label: null,
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
      key: row.key,
      percent: row.percent,
      value: percentValue(t, row.percent),
      label,
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
      key: item.key,
      percent: item.percent,
      value: percentValue(t, item.percent),
      label,
      // Ollama reports no reset instant for either window.
      detail: meterDetail(t, label, item.percent, null, observation.fetchedAt, locale),
    };
  });

  const cost = readActivityCost(observation.data);
  if (cost !== null) {
    signals.push({
      key: 'cost',
      percent: null,
      value: activityCostText(cost),
      label: null,
      detail: t('dashboard.upstreams.signals.costDetail'),
    });
  }
  return signals;
};

const upstreamSignals = (record: UpstreamRecord, t: TFunction, locale: string, now: number): UpstreamSignal[] => {
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

// The subscription an upstream serves on, where the upstream names one. Every
// name is the vendor's own marketing name for the plan, assembled from the
// fields the credential carries; an unrecognised value is forwarded rather than
// dropped, so a plan introduced upstream reads as itself.
const upstreamPlan = (record: UpstreamRecord): string | null => {
  switch (record.kind) {
  case 'custom':
  case 'azure':
  case 'copilot':
    return null;
  case 'ollama': return ollamaPlanLabel(record);
  case 'codex': return codexPlanLabel(record.config.accounts[0]);
  case 'claude-code': return claudeCodePlanLabel(record.config.accounts[0]);
  }
};

export const upstreamReadout = (record: UpstreamRecord, t: TFunction, locale: string, now: number): UpstreamReadout => ({
  plan: upstreamPlan(record) ?? t(`provider.${record.kind}`, providerLabel(record.kind)),
  signals: upstreamSignals(record, t, locale, now),
});

export function UpstreamSignals({ record }: { record: UpstreamRecord }) {
  const { t } = useTranslation();
  const locale = useLocale();
  // Codex drops a rate-limit window once it has expired, which is a change on
  // the wall clock rather than in the record.
  const now = useNow(WALL_CLOCK_REFRESH_MS);
  const { plan, signals } = upstreamReadout(record, t, locale, now);

  return <div className="flex items-center gap-x-3 min-w-0">
    <Text size={200} className="text-fui-fg2 flex-none" weight="semibold" wrap={false}>
      {signals.length === 0 ? plan : t('dashboard.upstreams.signals.plan', { plan })}
    </Text>
    {signals.map(signal => <Tooltip content={signal.detail} key={signal.key} relationship="description">
      <span className="winui-focus-rect inline-flex items-center gap-1 min-w-0" tabIndex={0}>
        {signal.percent !== null && <ProgressRing percent={signal.percent} tone={quotaRingTone(signal.percent)} />}
        <Text size={200} className="text-fui-fg2" weight="medium" wrap={false}>{signal.value}</Text>
        {signal.label !== null && <Text size={200} className="text-fui-fg3" truncate wrap={false}>{signal.label}</Text>}
      </span>
    </Tooltip>)}
  </div>;
}
