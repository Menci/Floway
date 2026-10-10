import type { UsageMetricDisplay } from '@floway-dev/provider';

// https://github.com/ollama/ollama/issues/12532#issuecomment-5117969589
export const ollamaUsageMetrics = (body: Record<string, unknown>): Map<string, number> => {
  const metrics = new Map<string, number>();
  const limits = body.limits;
  if (typeof limits === 'object' && limits !== null) {
    for (const [name, window] of Object.entries(limits)) {
      if (typeof window === 'object' && window !== null && 'usage' in window && typeof window.usage === 'number') {
        metrics.set(JSON.stringify(['window', name]), window.usage * 100);
      }
    }
  }
  const activity = body.activity;
  if (typeof activity === 'object' && activity !== null && 'cost' in activity && 'period' in activity) {
    const period = activity.period;
    if (typeof period === 'object' && period !== null && 'type' in period && typeof period.type === 'string') {
      const cost = activity.cost;
      if (typeof cost !== 'number' && (typeof cost !== 'string' || cost.trim() === '')) throw new TypeError('Ollama activity cost must be numeric');
      const value = Number(cost);
      if (!Number.isFinite(value)) throw new TypeError('Ollama activity cost must be finite');
      metrics.set(JSON.stringify(['activity_cost', period.type]), value);
    }
  }
  return metrics;
};

export const resolveUsageMetricDisplayName = (key: string): UsageMetricDisplay => {
  const [kind, name] = JSON.parse(key) as [string, string];
  if ((kind !== 'window' && kind !== 'activity_cost') || typeof name !== 'string') throw new TypeError('Invalid Ollama usage metric key');
  return { name, unit: kind === 'window' ? 'percent' : 'usd', windowMinutes: null };
};
