import type { TranslationKey, useTranslation } from '../../i18n/translation';
import type { UpstreamUsageMetricRecord } from '@floway-dev/gateway/browser';
import type { UsageMetricDisplay } from '@floway-dev/provider/browser';
import { resolveUsageMetricDisplayName as claudeCodeDisplay } from '@floway-dev/provider-claude-code/browser';
import { resolveUsageMetricDisplayName as codexDisplay } from '@floway-dev/provider-codex/browser';
import { resolveUsageMetricDisplayName as copilotDisplay } from '@floway-dev/provider-copilot/browser';
import { resolveUsageMetricDisplayName as ollamaDisplay } from '@floway-dev/provider-ollama/browser';

type Translate = ReturnType<typeof useTranslation>['t'];
export interface ResolvedUsageMetricDisplay extends UsageMetricDisplay { metricId: string }
const names = new Map<string, Exclude<Extract<TranslationKey, `dashboard.upstreamUsage.metrics.${string}`>, 'dashboard.upstreamUsage.metrics.window'>>([
  ['five_hour', 'dashboard.upstreamUsage.metrics.fiveHour'],
  ['seven_day', 'dashboard.upstreamUsage.metrics.sevenDay'],
  ['seven_day_sonnet', 'dashboard.upstreamUsage.metrics.sevenDaySonnet'],
  ['seven_day_opus', 'dashboard.upstreamUsage.metrics.sevenDayOpus'],
  ['overage', 'dashboard.upstreamUsage.metrics.overage'],
  ['extra_usage', 'dashboard.upstreamUsage.metrics.extraUsage'],
  ['premium_interactions', 'dashboard.upstreamUsage.metrics.premiumInteractions'],
  ['chat', 'dashboard.upstreamUsage.metrics.chat'],
  ['completions', 'dashboard.upstreamUsage.metrics.completions'],
  ['session', 'dashboard.upstreamUsage.metrics.session'],
  ['weekly', 'dashboard.upstreamUsage.metrics.sevenDay'],
  ['last_4_weeks', 'dashboard.upstreamUsage.metrics.fourWeeks'],
  ['credits_balance', 'dashboard.upstreamUsage.metrics.credits'],
]);

// Fixed window labels and duration-encoded unnamed windows share a comparison identity.
const fixedWindows = new Map<TranslationKey, number>([
  ['dashboard.upstreamUsage.metrics.fiveHour', 5 * 60],
  ['dashboard.upstreamUsage.metrics.sevenDay', 7 * 24 * 60],
]);

export const resolveUsageMetricDisplayName = (
  upstreamId: string,
  key: string,
  observations: ReadonlyMap<string, UpstreamUsageMetricRecord>,
  t: Translate,
): ResolvedUsageMetricDisplay => {
  const observation = observations.get(JSON.stringify([upstreamId, key]))!;
  let display: UsageMetricDisplay;
  switch (observation.provider) {
  case 'codex': display = codexDisplay(key); break;
  case 'copilot': display = copilotDisplay(key); break;
  case 'claude-code': display = claudeCodeDisplay(key); break;
  case 'ollama': display = ollamaDisplay(key); break;
  default: throw new TypeError('Provider does not expose upstream usage metrics');
  }
  const translation = names.get(display.name);
  const name = translation === undefined ? display.name : t(translation);
  const fixedWindow = display.windowMinutes === null && translation !== undefined ? fixedWindows.get(translation) : undefined;
  const metricId = JSON.stringify([fixedWindow !== undefined ? ['name', ''] : translation === undefined ? ['name', display.name] : ['translation', translation], fixedWindow ?? display.windowMinutes, display.unit]);
  if (display.windowMinutes === null) return { ...display, name, metricId };
  const minutes = display.windowMinutes;
  const window = minutes % 1440 === 0 ? t('dashboard.upstreamUsage.windows.days', { count: minutes / 1440 })
    : minutes % 60 === 0 ? t('dashboard.upstreamUsage.windows.hours', { count: minutes / 60 })
      : t('dashboard.upstreamUsage.windows.minutes', { count: minutes });
  return {
    ...display,
    metricId,
    name: name === '' ? window : t('dashboard.upstreamUsage.metrics.window', { name, window }),
  };
};
