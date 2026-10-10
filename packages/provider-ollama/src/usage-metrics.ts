import type { UsageMetricDisplay } from '@floway-dev/provider';

// https://github.com/ollama/ollama/issues/12532#issuecomment-5117969589
export const ollamaUsageMetrics = (body: unknown): Map<string, number> => {
  const metrics = new Map<string, number>();
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new TypeError('Ollama usage observation must be an object');
  const observation = body as Record<string, unknown>;
  const limits = observation.limits;
  if (typeof limits === 'object' && limits !== null) {
    for (const [name, window] of Object.entries(limits)) {
      if (typeof window === 'object' && window !== null && 'usage' in window && typeof window.usage === 'number' && Number.isFinite(window.usage)) {
        metrics.set(JSON.stringify(['window', name]), window.usage * 100);
      }
    }
  }
  const activity = observation.activity;
  if (typeof activity === 'object' && activity !== null && 'cost' in activity && 'period' in activity) {
    const period = activity.period;
    if (typeof period === 'object' && period !== null && 'type' in period && typeof period.type === 'string') {
      const cost = activity.cost;
      if ((typeof cost === 'string' && cost.trim() !== '') || typeof cost === 'number') {
        const value = Number(cost);
        if (!Number.isFinite(value)) throw new TypeError('Ollama activity cost must be finite');
        metrics.set(JSON.stringify(['activity_cost', period.type]), value);
      }
    }
  }
  return metrics;
};

export const resolveUsageMetricDisplayName = (key: string): UsageMetricDisplay => {
  const [kind, name] = JSON.parse(key) as [string, string];
  if ((kind !== 'window' && kind !== 'activity_cost') || typeof name !== 'string') throw new TypeError('Invalid Ollama usage metric key');
  return { name, unit: kind === 'window' ? 'percent' : 'usd', windowMinutes: null };
};
