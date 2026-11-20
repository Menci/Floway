import type { UpstreamMetricsMetadata } from './data';
import type { TFunction } from '../../i18n/translation';
import { resolveUpstreamMetricDisplaySeries, type UpstreamMetricDisplay, type UpstreamMetricDisplayOptions, type UpstreamMetricDisplaySeries, type UpstreamMetricLabelKey, type UpstreamMetricSample } from '@floway-dev/provider/browser';
import { resolveUpstreamMetricDisplays as chatgptDisplays } from '@floway-dev/provider-chatgpt/browser';
import { resolveUpstreamMetricDisplays as claudeCodeDisplays } from '@floway-dev/provider-claude-code/browser';
import { resolveUpstreamMetricDisplays as copilotDisplays } from '@floway-dev/provider-copilot/browser';
import { resolveUpstreamMetricDisplays as kimiCodeDisplays } from '@floway-dev/provider-kimi-code/browser';
import { resolveUpstreamMetricDisplays as ollamaDisplays } from '@floway-dev/provider-ollama/browser';

export type ResolvedUpstreamMetricDisplay = UpstreamMetricDisplay;

export interface ResolvedUpstreamMetricDisplaySeries extends Omit<UpstreamMetricDisplaySeries, 'display'> {
  display: ResolvedUpstreamMetricDisplay;
}

// Every key a provider may name. Listing them here is what makes the orphan-key
// suite see them, and the annotation is what proves each one exists in the
// English catalogue.
const providerLabelKeys: ReadonlyArray<UpstreamMetricLabelKey> = [
  'monitoring.upstreams.series.copilot.chat.allowance',
  'monitoring.upstreams.series.copilot.chat.remaining',
  'monitoring.upstreams.series.copilot.chat.usage',
  'monitoring.upstreams.series.copilot.completions.allowance',
  'monitoring.upstreams.series.copilot.completions.remaining',
  'monitoring.upstreams.series.copilot.completions.usage',
  'monitoring.upstreams.series.copilot.other.allowance',
  'monitoring.upstreams.series.copilot.other.remaining',
  'monitoring.upstreams.series.copilot.other.usage',
  'monitoring.upstreams.series.copilot.premiumInteractions.allowance',
  'monitoring.upstreams.series.copilot.premiumInteractions.remaining',
  'monitoring.upstreams.series.copilot.premiumInteractions.usage',
  'monitoring.upstreams.series.credits',
  'monitoring.upstreams.series.extraUsage',
  'monitoring.upstreams.series.includedAllowance',
  'monitoring.upstreams.series.includedBalance',
  'monitoring.upstreams.series.monthlyRemaining',
  'monitoring.upstreams.series.monthlyUsage',
  'monitoring.upstreams.series.namedRemaining',
  'monitoring.upstreams.series.namedUsage',
  'monitoring.upstreams.series.past24HoursCost',
  'monitoring.upstreams.series.past30DaysCost',
  'monitoring.upstreams.series.past7DaysCost',
  'monitoring.upstreams.series.purchasedBalance',
  'monitoring.upstreams.series.remaining',
  'monitoring.upstreams.series.sessionRemaining',
  'monitoring.upstreams.series.sessionUsage',
  'monitoring.upstreams.series.usage',
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
  case 'chatgpt': return chatgptDisplays(samples, options);
  case 'copilot': return copilotDisplays(samples, options);
  case 'claude-code': return claudeCodeDisplays(samples, options);
  case 'kimi-code': return kimiCodeDisplays(samples, options);
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
  const window = seconds % 86_400 === 0 ? t('monitoring.upstreams.windows.days', { count: seconds / 86_400 })
    : seconds % 3_600 === 0 ? t('monitoring.upstreams.windows.hours', { count: seconds / 3_600 })
      : seconds % 60 === 0 ? t('monitoring.upstreams.windows.minutes', { count: seconds / 60 })
        : t('monitoring.upstreams.windows.seconds', { count: seconds });
  const name = display.labelKey === null
    ? display.name === '' ? window : t('monitoring.upstreams.series.window', { name: display.name, window })
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
