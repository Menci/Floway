export const CREDIT_BALANCE = {
  included: { balance_usd: 18, allowance_usd: 60, period: { from: '2026-10-01T00:00:00Z', until: '2026-11-01T00:00:00Z' } },
  purchased: { balance_usd: 25 },
};
export const LEGACY_BALANCE = {
  included: { session: { remaining_percent: 75, resets_at: '2026-10-11T09:00:00Z' }, weekly: { remaining_percent: 60, resets_at: '2026-10-15T04:00:00Z' } },
  purchased: { balance_usd: 25 },
};
export const USAGE_TOTALS = {
  range: '7d', scope: 'self', from: '2026-10-04T00:00:00Z', until: '2026-10-11T04:00:00Z', totals: { request_count: 15, usage_usd: 3.25 },
};
export const accountUsage = (balance = CREDIT_BALANCE, usage = USAGE_TOTALS) => ({ balance, usage });
