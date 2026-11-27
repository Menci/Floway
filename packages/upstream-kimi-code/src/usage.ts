import { object, number, timestamp } from './validation.ts';

export interface KimiCodeQuotaWindow {
  id: 'five_hour' | 'monthly' | 'weekly';
  /** Dimensionless fraction consumed, where 1 means the full allowance. */
  usedRatio: number;
  resetsAt: string;
}

// https://github.com/MoonshotAI/kimi-code/blob/fec742878d73678082b304c887e4fb1564088c54/apps/kimi-code/src/utils/usage/usage-format.ts#L92-L114
export const KIMI_CODE_WINDOW_SECONDS = { five_hour: 18_000, monthly: null, weekly: 604_800 } as const satisfies Record<KimiCodeQuotaWindow['id'], number | null>;

// The two plan generations publish different windows. Both report ratios in
// `usages`; the absolute counters are not documented as token counts.
// The official CLI renders percentages rather than assigning a unit.
// https://github.com/MoonshotAI/kimi-cli/blob/9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82/src/kimi_cli/ui/shell/usage.py#L255-L270
export interface KimiCodeAccountUsage {
  windows: KimiCodeQuotaWindow[];
  /** Code usage as a fraction of the shared monthly allowance, not a second cap. */
  monthlyCodeUsedRatio: number | null;
}

// https://github.com/MoonshotAI/kimi-code/blob/fec742878d73678082b304c887e4fb1564088c54/packages/oauth/src/managed-usage.ts#L114-L145
// https://github.com/MoonshotAI/kimi-code/blob/fec742878d73678082b304c887e4fb1564088c54/packages/oauth/src/managed-usage.ts#L198-L204
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
