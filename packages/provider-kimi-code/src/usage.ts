import type { Result } from '@floway-dev/pipeline';
import { isJsonObject } from '@floway-dev/protocols/common';

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
const ratio = (value: unknown, path: string): Result<number, TypeError | RangeError> => {
  const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return { ok: false, error: new TypeError(`${path} must be a finite number`) };
  if (parsed < 0) return { ok: false, error: new RangeError(`${path} must be nonnegative`) };
  return { ok: true, value: parsed };
};

// Kimi Code's wire usage can contain either quota generation.
// https://github.com/MoonshotAI/kimi-code/blob/fec742878d73678082b304c887e4fb1564088c54/apps/kimi-code/src/utils/usage/usage-format.ts#L92-L114
export const parseKimiCodeUsage = (body: unknown): Result<KimiCodeAccountUsage, TypeError | RangeError> => {
  if (!isJsonObject(body)) return { ok: false, error: new TypeError('Kimi Code usages must be an object') };
  const { usages } = body;
  if (!isJsonObject(usages)) return { ok: false, error: new TypeError('Kimi Code usages.usages must be an object') };
  const ids = body.usage === undefined
    ? [['five_hour', 'limit_5h'], ['monthly', 'limit_month_total']] as const
    : [['five_hour', 'limit_5h'], ['weekly', 'limit_7d']] as const;
  const windows: KimiCodeQuotaWindow[] = [];
  for (const [id, field] of ids) {
    const entry = usages[field];
    if (!isJsonObject(entry)) return { ok: false, error: new TypeError(`Kimi Code usages.${field} must be an object`) };
    const usedRatio = ratio(entry.used_ratio, `Kimi Code usages.${field}.used_ratio`);
    if (!usedRatio.ok) return usedRatio;
    const resetsAt = entry.reset_time;
    if (typeof resetsAt !== 'string' || resetsAt === '') return { ok: false, error: new TypeError(`Kimi Code usages.${field}.reset_time must be a nonempty string`) };
    if (!Number.isFinite(Date.parse(resetsAt))) return { ok: false, error: new TypeError(`Kimi Code usages.${field}.reset_time must be an ISO timestamp`) };
    windows.push({ id, usedRatio: usedRatio.value, resetsAt });
  }
  if (body.usage !== undefined) return { ok: true, value: { windows, monthlyCodeUsedRatio: null } };
  const code = usages.limit_month_code;
  if (!isJsonObject(code)) return { ok: false, error: new TypeError('Kimi Code usages.limit_month_code must be an object') };
  const used = ratio(code.used_ratio, 'Kimi Code usages.limit_month_code.used_ratio');
  return used.ok ? { ok: true, value: { windows, monthlyCodeUsedRatio: used.value } } : used;
};

// Stored observations passed wire validation before they were persisted.
export const readKimiCodeUsage = (body: unknown): KimiCodeAccountUsage => {
  const parsed = parseKimiCodeUsage(body);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
};
