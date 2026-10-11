import { readOllamaAccountUsage } from './account-usage.ts';

export const ollamaUsageMetrics = (body: unknown): Map<string, number> => {
  const { included, purchasedBalanceUsd, activity } = readOllamaAccountUsage(body);
  const metrics = new Map<string, number>();
  if (included.kind === 'credits') {
    metrics.set(JSON.stringify(['balance', 'included']), included.balanceUsd);
  } else {
    for (const name of ['session', 'weekly'] as const) metrics.set(JSON.stringify(['window', name]), 100 - included[name].remainingPercent);
  }
  metrics.set(JSON.stringify(['balance', 'purchased']), purchasedBalanceUsd);
  if (activity.usageUsd !== null) metrics.set(JSON.stringify(['activity_cost', activity.range]), activity.usageUsd);
  return metrics;
};

export const resolveUsageMetricDisplayName = (key: string): { name: string; unit: 'percent' | 'usd'; windowMinutes: null } => {
  const [kind, name] = JSON.parse(key) as [string, string];
  if ((kind !== 'window' && kind !== 'activity_cost' && kind !== 'balance') || typeof name !== 'string') throw new TypeError('Invalid Ollama usage metric key');
  return { name: kind === 'activity_cost' ? `cost_${name}` : name, unit: kind === 'window' ? 'percent' : 'usd', windowMinutes: null };
};
