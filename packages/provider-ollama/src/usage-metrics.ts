// Activity-window observations use fractional utilization; balance reports remaining percentages.
// https://github.com/ollama/ollama/issues/12532#issuecomment-5117969589
// https://github.com/ollama/ollama/blob/eab97e9f92b9a25c2d52d2cc6c1b1c99bd9fae21/docs/api/cloud-usage.mdx
// https://github.com/ollama/ollama/blob/eab97e9f92b9a25c2d52d2cc6c1b1c99bd9fae21/docs/api/balance.mdx
export const ollamaUsageMetrics = (body: unknown): Map<string, number> => {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new TypeError('Ollama usage observation must be an object');
  const observation = body as Record<string, unknown>;
  const metrics = new Map<string, number>();
  const limits = observation.limits;
  if (typeof limits === 'object' && limits !== null) {
    for (const [name, window] of Object.entries(limits)) {
      if (typeof window === 'object' && window !== null && 'usage' in window && typeof window.usage === 'number' && Number.isFinite(window.usage)) {
        metrics.set(JSON.stringify(['window', name]), window.usage * 100);
      }
    }
  }
  const included = observation.included;
  if (typeof included === 'object' && included !== null) {
    for (const [name, window] of Object.entries(included)) {
      if (typeof window === 'object' && window !== null && 'remaining_percent' in window && typeof window.remaining_percent === 'number' && Number.isFinite(window.remaining_percent)) {
        metrics.set(JSON.stringify(['window', name]), 100 - window.remaining_percent);
      }
    }
  }
  for (const name of ['included', 'purchased']) {
    const balance = observation[name];
    if (typeof balance === 'object' && balance !== null && 'balance_usd' in balance && typeof balance.balance_usd === 'number' && Number.isFinite(balance.balance_usd)) {
      metrics.set(JSON.stringify(['balance', name]), balance.balance_usd);
    }
  }
  const activity = observation.activity;
  if (typeof activity === 'object' && activity !== null && 'cost' in activity && 'period' in activity) {
    const period = activity.period;
    if (typeof period === 'object' && period !== null && 'type' in period && typeof period.type === 'string') {
      const cost = activity.cost;
      if ((typeof cost === 'string' && cost.trim() !== '') || typeof cost === 'number') {
        const amount = Number(cost);
        if (!Number.isFinite(amount)) throw new TypeError('Ollama activity cost must be finite');
        metrics.set(JSON.stringify(['activity_cost', period.type]), amount);
      }
    }
  }
  const totals = observation.totals;
  if (typeof totals === 'object' && totals !== null && 'usage_usd' in totals) {
    if (typeof totals.usage_usd !== 'number' || !Number.isFinite(totals.usage_usd)) throw new TypeError('Ollama usage total must be finite');
    if (typeof observation.range !== 'string') throw new TypeError('Ollama usage total requires its range');
    metrics.set(JSON.stringify(['activity_cost', observation.range]), totals.usage_usd);
  }
  return metrics;
};

export const resolveUsageMetricDisplayName = (key: string): { name: string; unit: 'percent' | 'usd'; windowMinutes: null } => {
  const [kind, name] = JSON.parse(key) as [string, string];
  if ((kind !== 'window' && kind !== 'activity_cost' && kind !== 'balance') || typeof name !== 'string') throw new TypeError('Invalid Ollama usage metric key');
  return { name, unit: kind === 'window' ? 'percent' : 'usd', windowMinutes: null };
};
