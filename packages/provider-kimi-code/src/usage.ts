import { object, number, timestamp } from './validation.ts';

export interface KimiCodeQuotaWindow {
  id: 'five_hour' | 'monthly' | 'weekly';
  /** Dimensionless fraction consumed, where 1 means the full allowance. */
  usedRatio: number;
  resetsAt: string;
}

export interface KimiCodeUsageData {
  limits: unknown[];
  usages: Record<string, { used_ratio: number | string; reset_time: string }>;
  usage?: Record<string, unknown>;
  /** Native wallet fields; its balance.amount has no documented currency scale. */
  booster_wallet?: Record<string, unknown>;
}

// The two plan generations publish different windows. Both report ratios in
// `usages`; the absolute counters use subscription units, not token counts.
// The official CLI likewise renders percentages rather than assigning a unit.
// https://github.com/MoonshotAI/kimi-cli/blob/9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82/src/kimi_cli/ui/shell/usage.py#L85-L200
export interface KimiCodeAccountUsage {
  windows: KimiCodeQuotaWindow[];
  /** Code usage as a fraction of the shared monthly allowance, not a second cap. */
  monthlyCodeUsedRatio: number | null;
}

// https://github.com/MoonshotAI/kimi-code/blob/fec742878d73678082b304c887e4fb1564088c54/packages/oauth/src/managed-usage.ts#L114-L145
const ratio = (value: unknown, path: string): number => {
  const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  const result = number(parsed, path);
  if (result < 0) throw new RangeError(`${path} must be nonnegative`);
  return result;
};

// https://github.com/MoonshotAI/kimi-code/blob/fec742878d73678082b304c887e4fb1564088c54/apps/kimi-code/src/utils/usage/usage-format.ts#L92-L114
export const readKimiCodeUsage = (value: unknown): KimiCodeAccountUsage => {
  const body = object(value, 'Kimi Code usages');
  const usages = object(body.usages, 'Kimi Code usages.usages');
  if (!Array.isArray(body.limits)) throw new TypeError('Kimi Code usages.limits must be an array');
  if (body.usage !== undefined) object(body.usage, 'Kimi Code usages.usage');
  if (body.booster_wallet !== undefined) object(body.booster_wallet, 'Kimi Code usages.booster_wallet');
  const ids = body.usage === undefined
    ? [['five_hour', 'limit_5h'], ['monthly', 'limit_month_total']] as const
    : [['five_hour', 'limit_5h'], ['weekly', 'limit_7d']] as const;
  const windows = ids.map(([id, field]) => {
    const entry = object(usages[field], `Kimi Code usages.${field}`);
    const usedRatio = ratio(entry.used_ratio, `Kimi Code usages.${field}.used_ratio`);
    return { id, usedRatio, resetsAt: timestamp(entry.reset_time, `Kimi Code usages.${field}.reset_time`) };
  });
  const code = body.usage === undefined ? object(usages.limit_month_code, 'Kimi Code usages.limit_month_code') : null;
  return { windows, monthlyCodeUsedRatio: code === null ? null : ratio(code.used_ratio, 'Kimi Code usages.limit_month_code.used_ratio') };
};
