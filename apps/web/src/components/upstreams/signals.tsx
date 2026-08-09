// What an upstream reports about itself beyond its identity: the live readings
// its own provider decides are worth a glance from the list, without opening
// the editor. Each provider contributes what its upstream actually publishes,
// so an upstream with nothing to report contributes nothing and its row stays
// one line high.

import { findCredential, planLabel as claudeCodePlanLabel, quotaWindows, WINDOW_MINUTES } from './claude-code-account';
import { latestCredits, latestQuotaEntry, planLabel as codexPlanLabel, quotaEntries } from './codex-account';
import { copilotQuota, readBuckets } from './copilot-quota';
import { planLabel as copilotPlanLabel } from './copilot-seat';
import { planLabel as ollamaPlanLabel } from './ollama-account';
import { activityCostText, isZeroActivityCost, readActivityCost, readWindows } from './ollama-usage';
import { providerLabel } from './provider-badge';
import { quotaRingTone, WALL_CLOCK_REFRESH_MS, windowLengthLabel } from './subscription-quota';
import type { UpstreamRecord } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { type TFunction, useTranslation } from '../../i18n/translation';
import { formatRemaining } from '../../lib/format-duration';
import { dateTime, shortDate } from '../../lib/format-time';
import { useLocale } from '../../lib/use-locale';
import { useNow } from '../../lib/use-now';
import { ProgressRing } from '../ui/progress-ring';

const { Text, Tooltip, makeStyles, mergeClasses } = fluentComponents;

const useStyles = makeStyles({
  // The reading and the window it covers are two steps of the same line, and
  // hovering lifts both together, so the colours are named on the signal and
  // read by the parts. The label's resting alpha is the operator's, not a step
  // of the WinUI text ramp -- its quietest is 0.36, and this line wanted less.
  signal: {
    '--floway-signal-value': 'var(--winui-text-fill-tertiary)',
    '--floway-signal-label': 'rgba(0, 0, 0, 0.25)',
    '@media (prefers-color-scheme: dark)': {
      '--floway-signal-label': 'rgba(255, 255, 255, 0.25)',
    },
    ':hover': {
      '--floway-signal-value': 'var(--winui-text-fill-primary)',
      '--floway-signal-label': 'var(--winui-text-fill-secondary)',
    },
    // The signal is reachable by keyboard for its tooltip, so it answers focus
    // the same way it answers the pointer.
    ':focus-visible': {
      '--floway-signal-value': 'var(--winui-text-fill-primary)',
      '--floway-signal-label': 'var(--winui-text-fill-secondary)',
    },
  },
  // Both switch outright. WinUI eases a control's own fill and nothing else --
  // its foreground crosses instantly -- and a reading is foreground throughout.
  // https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L172-L175
  value: { color: 'var(--floway-signal-value)' },
  label: { color: 'var(--floway-signal-label)' },
  // A reading that says the upstream is refusing work outranks its own tone.
  blocked: { color: 'var(--winui-system-fill-critical)' },
});

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
  /**
   * The upstream is refusing work right now. It is stated rather than inferred
   * from a percentage: a block and a full window are different facts, and an
   * account can be refused while every window this row shows reads low.
   */
  blocked?: boolean;
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
// tooltip renders its content as a single run of text. The glue between the
// facts is the locale's, as it is for every other string this app composes:
// zh-Hans separates them with a full-width comma, not a spaced hyphen.
const detailText = (t: TFunction, parts: (string | null)[]): string =>
  parts.filter(part => part !== null).join(t('dashboard.upstreams.signals.detailSeparator'));

const meterDetail = (t: TFunction, label: string, percent: number, resetAt: string | null, observedAt: string | number | null, locale: string): string =>
  detailText(t, [
    t('dashboard.upstreams.signals.used', { label, percent: Math.round(percent) }),
    resetAt === null ? null : t('dashboard.upstreams.signals.resets', { time: dateTime(resetAt, locale) }),
    observedAt === null ? null : t('dashboard.upstreams.signals.observed', { time: dateTime(observedAt, locale) }),
  ]);

// As the upstream reported it: an overage-permitted bucket runs past 100, and
// only the ring beside the number is clamped.
const percentValue = (t: TFunction, percent: number): string =>
  t('dashboard.upstreams.signals.percent', { percent: Math.round(percent) });

// Last on the line: the windows are what an operator reads at a glance, and this
// says how long the wait still has to run rather than when it ends -- an instant
// has to be subtracted from the clock before it means anything.
const blockedSignal = (until: string, t: TFunction, locale: string, now: number): UpstreamSignal => ({
  key: 'rate-limited',
  percent: null,
  value: t('dashboard.upstreams.signals.rateLimited'),
  label: formatRemaining(Date.parse(until) - now, locale),
  detail: t('dashboard.upstreams.signals.rateLimitedDetail', { time: dateTime(until, locale) }),
  blocked: true,
});

const copilotSignals = (record: Extract<UpstreamRecord, { kind: 'copilot' }>, t: TFunction, locale: string): UpstreamSignal[] => {
  const quota = copilotQuota(record);
  if (quota === null) return [];
  // Only what is capped: the editor card stands a row in for a seat with nothing
  // metered, but a row of readings has nothing to read there. A seat's buckets
  // all reset together, so the date says more here than the bucket's own name
  // would; the name stays in the tooltip. The id is an open string GitHub owns
  // and is never rewritten into a table of ours.
  return readBuckets(quota)
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

  // A balance of nothing says nothing here, whether the account reports it as a
  // zero or as having no credits at all -- and Codex's own status line drops any
  // balance at or below zero. The editor card keeps both, as it keeps a charge
  // of nothing.
  const balance = credits?.credits_has_credits === false ? 0 : credits?.credits_balance;
  if (balance !== undefined && Number.isFinite(balance) && balance > 0) {
    signals.push({
      key: 'credits',
      percent: null,
      value: t('dashboard.upstreams.signals.credits', { balance }),
      label: null,
      detail: t('dashboard.upstreams.signals.creditsDetail'),
    });
  }
  // The windows beside it can read low while it holds: a 429 names the limit
  // family that tripped, which is not always one of the two this row shows.
  if (entry?.rateLimitedUntil != null) signals.push(blockedSignal(entry.rateLimitedUntil, t, locale, now));
  return signals;
};

const claudeCodeSignals = (record: Extract<UpstreamRecord, { kind: 'claude-code' }>, t: TFunction, locale: string, now: number): UpstreamSignal[] => {
  const lookup = findCredential(record);
  const credential = lookup.kind === 'present' ? lookup.credential : null;
  const quota = credential?.quotaSnapshot?.data ?? null;
  const windows: UpstreamSignal[] = quotaWindows(credential).map(row => {
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

  // `rejected` on the unified status is Anthropic saying it turned the request
  // away, which it reports apart from the per-window utilization beside it. An
  // undated refusal states the fact alone; there is nothing to count down.
  if (quota?.status !== 'rejected') return windows;
  return windows.concat(quota.reset === null
    ? [{
        key: 'rate-limited',
        percent: null,
        value: t('dashboard.upstreams.signals.rateLimited'),
        label: null,
        detail: t('dashboard.upstreams.signals.rateLimitedUndated'),
        blocked: true,
      }]
    : [blockedSignal(quota.reset, t, locale, now)]);
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
  if (cost !== null && !isZeroActivityCost(cost.amount)) {
    signals.push({
      key: 'cost',
      percent: null,
      value: activityCostText(cost.amount),
      label: null,
      detail: cost.period === 'last_4_weeks'
        ? t('dashboard.upstreams.signals.costLast4Weeks')
        : t('dashboard.upstreams.signals.cost'),
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
  case 'claude-code': return claudeCodeSignals(record, t, locale, now);
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
    return null;
  case 'copilot': return copilotPlanLabel(record);
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
  const styles = useStyles();
  // A rate limit is stated as the time it still has to run, so the readout
  // counts down on the wall clock rather than only when the record changes.
  const now = useNow(WALL_CLOCK_REFRESH_MS);
  const { plan, signals } = upstreamReadout(record, t, locale, now);

  return <div className="flex items-baseline gap-x-1.5 min-w-0">
    <Text size={200} className="text-fui-fg3 flex-none" weight="medium" wrap={false}>
      {signals.length === 0 ? plan : t('dashboard.upstreams.signals.plan', { plan })}
    </Text>
    <div className="flex items-baseline gap-x-3 min-w-0">
      {signals.map(signal => <Tooltip content={signal.detail} key={signal.key} relationship="description">
        <span className={mergeClasses('winui-focus-rect inline-flex items-baseline gap-1 min-w-0', styles.signal)} tabIndex={0}>
          {signal.percent !== null && <ProgressRing percent={signal.percent} tone={quotaRingTone(signal.percent)} />}
          <Text size={200} className={signal.blocked === true ? styles.blocked : styles.value} weight="medium" wrap={false}>{signal.value}</Text>
          {signal.label !== null && <Text size={200} className={styles.label} truncate wrap={false}>{signal.label}</Text>}
        </span>
      </Tooltip>)}
    </div>
  </div>;
}
