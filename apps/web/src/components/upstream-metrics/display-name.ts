import type { UpstreamMetricsMetadata } from './data';
import type { TFunction } from '../../i18n/translation';
import { resolveUpstreamMetricDisplaySeries, type UpstreamMetricDisplay, type UpstreamMetricDisplayOptions, type UpstreamMetricDisplaySeries, type UpstreamMetricLabelKey, type UpstreamMetricSample } from '@floway-dev/provider/browser';
import { resolveUpstreamMetricDisplays as claudeCodeDisplays } from '@floway-dev/provider-claude-code/browser';
import { resolveUpstreamMetricDisplays as codexDisplays } from '@floway-dev/provider-codex/browser';
import { resolveUpstreamMetricDisplays as copilotDisplays } from '@floway-dev/provider-copilot/browser';
import { resolveUpstreamMetricDisplays as ollamaDisplays } from '@floway-dev/provider-ollama/browser';

export type ResolvedUpstreamMetricDisplay = UpstreamMetricDisplay;

export interface ResolvedUpstreamMetricDisplaySeries extends Omit<UpstreamMetricDisplaySeries, 'display'> {
  display: ResolvedUpstreamMetricDisplay;
}

// Every key a provider may name. Listing them here is what makes the orphan-key
// suite see them, and the annotation is what proves each one exists in the
// English catalogue.
const providerLabelKeys: ReadonlyArray<UpstreamMetricLabelKey> = [
  'dashboard.upstreams.copilotQuota.chat.allowance',
  'dashboard.upstreams.copilotQuota.chat.remaining',
  'dashboard.upstreams.copilotQuota.chat.usage',
  'dashboard.upstreams.copilotQuota.completions.allowance',
  'dashboard.upstreams.copilotQuota.completions.remaining',
  'dashboard.upstreams.copilotQuota.completions.usage',
  'dashboard.upstreams.copilotQuota.other.allowance',
  'dashboard.upstreams.copilotQuota.other.remaining',
  'dashboard.upstreams.copilotQuota.other.usage',
  'dashboard.upstreams.copilotQuota.premiumInteractions.allowance',
  'dashboard.upstreams.copilotQuota.premiumInteractions.remaining',
  'dashboard.upstreams.copilotQuota.premiumInteractions.usage',
  'dashboard.upstreamMetrics.metrics.credits',
  'dashboard.upstreamMetrics.metrics.extraUsage',
  'dashboard.upstreamMetrics.metrics.includedAllowance',
  'dashboard.upstreamMetrics.metrics.includedBalance',
  'dashboard.upstreamMetrics.metrics.namedRemaining',
  'dashboard.upstreamMetrics.metrics.namedUsage',
  'dashboard.upstreamMetrics.metrics.past24HoursCost',
  'dashboard.upstreamMetrics.metrics.past30DaysCost',
  'dashboard.upstreamMetrics.metrics.past7DaysCost',
  'dashboard.upstreamMetrics.metrics.purchasedBalance',
  'dashboard.upstreamMetrics.metrics.remaining',
  'dashboard.upstreamMetrics.metrics.sessionRemaining',
  'dashboard.upstreamMetrics.metrics.sessionUsage',
  'dashboard.upstreamMetrics.metrics.usage',
];

// The provider chooses the key; this boundary is where that open string enters
// the dashboard's catalogue, so an unknown key fails loudly instead of render-
// ing as itself.
const translatedKey = (key: UpstreamMetricLabelKey): string => {
  if (!providerLabelKeys.includes(key)) throw new TypeError(`Unknown upstream metric label key: ${key}`);
  return key;
};

const decodeProviderMetrics = (
  kind: UpstreamMetricsMetadata['kind'],
  samples: readonly UpstreamMetricSample[],
  options: UpstreamMetricDisplayOptions,
): UpstreamMetricDisplaySeries[] => {
  switch (kind) {
  case 'codex': return codexDisplays(samples, options);
  case 'copilot': return copilotDisplays(samples, options);
  case 'claude-code': return claudeCodeDisplays(samples, options);
  case 'ollama': return ollamaDisplays(samples, options);
  default: return resolveUpstreamMetricDisplaySeries(samples, options, () => null);
  }
};

const localizeDisplay = (
  display: UpstreamMetricDisplay,
  t: TFunction,
): ResolvedUpstreamMetricDisplay => {
  if (display.windowSeconds === null) {
    const name = display.labelKey === null ? display.name : t(translatedKey(display.labelKey), display.labelValues);
    return { ...display, name };
  }
  const seconds = display.windowSeconds;
  const window = seconds % 86_400 === 0 ? t('dashboard.upstreamMetrics.windows.days', { count: seconds / 86_400 })
    : seconds % 3_600 === 0 ? t('dashboard.upstreamMetrics.windows.hours', { count: seconds / 3_600 })
      : seconds % 60 === 0 ? t('dashboard.upstreamMetrics.windows.minutes', { count: seconds / 60 })
        : t('dashboard.upstreamMetrics.windows.seconds', { count: seconds });
  const name = display.labelKey === null
    ? display.name === '' ? window : t('dashboard.upstreamMetrics.metrics.window', { name: display.name, window })
    : t(translatedKey(display.labelKey), { ...display.labelValues, window });
  return { ...display, name };
};

export const resolveUpstreamMetricDisplays = (
  upstream: UpstreamMetricsMetadata,
  samples: readonly UpstreamMetricSample[],
  t: TFunction,
  options: UpstreamMetricDisplayOptions,
): ResolvedUpstreamMetricDisplaySeries[] => decodeProviderMetrics(upstream.kind, samples, options).map(series => ({
  ...series,
  display: localizeDisplay(series.display, t),
}));
