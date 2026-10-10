export interface OllamaUsageData {
  usage: unknown;
  balance: unknown;
}

export interface OllamaUsageWindow {
  remainingPercent: number;
  resetsAt: string;
}

export interface OllamaAccountUsage {
  included:
    | { kind: 'credits'; balanceUsd: number; allowanceUsd: number; from: string; until: string }
    | { kind: 'legacy'; session: OllamaUsageWindow; weekly: OllamaUsageWindow };
  purchasedBalanceUsd: number;
  activity: { range: string; scope: string; from: string; until: string; requestCount: number; usageUsd: number | null };
}

const object = (value: unknown, path: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${path} must be an object`);
  return value as Record<string, unknown>;
};

const number = (value: unknown, path: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${path} must be a finite number`);
  return value;
};

const string = (value: unknown, path: string): string => {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${path} must be a nonempty string`);
  return value;
};

const timestamp = (value: unknown, path: string): string => {
  const result = string(value, path);
  if (!Number.isFinite(Date.parse(result))) throw new TypeError(`${path} must be a timestamp`);
  return result;
};

const window = (value: unknown, path: string): OllamaUsageWindow => {
  const body = object(value, path);
  const remainingPercent = number(body.remaining_percent, `${path}.remaining_percent`);
  if (remainingPercent < 0 || remainingPercent > 100) throw new RangeError(`${path}.remaining_percent must be between 0 and 100`);
  return { remainingPercent, resetsAt: timestamp(body.resets_at, `${path}.resets_at`) };
};

// Legacy plans remain supported by /api/balance, independently of the new
// /api/usage response. Plan names such as Pro do not distinguish billing modes.
// https://github.com/ollama/ollama/blob/f864601538bd283dbcd011244db99e2760b125c1/docs/openapi.yaml#L1089-L1156
export const readOllamaAccountUsage = (value: unknown): OllamaAccountUsage => {
  const body = object(value, 'Ollama account usage');
  const balance = object(body.balance, 'Ollama balance');
  const included = object(balance.included, 'Ollama balance.included');
  const credits = Object.hasOwn(included, 'balance_usd');
  const legacy = Object.hasOwn(included, 'session') || Object.hasOwn(included, 'weekly');
  if (credits === legacy) throw new TypeError('Ollama balance.included must describe either credits or legacy limits');
  let allowance: OllamaAccountUsage['included'];
  if (credits) {
    const period = object(included.period, 'Ollama balance.included.period');
    allowance = {
      kind: 'credits', balanceUsd: number(included.balance_usd, 'Ollama balance.included.balance_usd'),
      allowanceUsd: number(included.allowance_usd, 'Ollama balance.included.allowance_usd'),
      from: timestamp(period.from, 'Ollama balance.included.period.from'), until: timestamp(period.until, 'Ollama balance.included.period.until'),
    };
  } else {
    allowance = { kind: 'legacy', session: window(included.session, 'Ollama balance.included.session'), weekly: window(included.weekly, 'Ollama balance.included.weekly') };
  }
  const purchased = object(balance.purchased, 'Ollama balance.purchased');
  const usage = object(body.usage, 'Ollama usage');
  const totals = object(usage.totals, 'Ollama usage.totals');
  const requestCount = number(totals.request_count, 'Ollama usage.totals.request_count');
  if (!Number.isSafeInteger(requestCount) || requestCount < 0) throw new RangeError('Ollama usage.totals.request_count must be a nonnegative integer');
  return {
    included: allowance, purchasedBalanceUsd: number(purchased.balance_usd, 'Ollama balance.purchased.balance_usd'),
    activity: {
      range: string(usage.range, 'Ollama usage.range'), scope: string(usage.scope, 'Ollama usage.scope'),
      from: timestamp(usage.from, 'Ollama usage.from'), until: timestamp(usage.until, 'Ollama usage.until'), requestCount,
      // Legacy requests omit monetary totals; absence is not a zero reading.
      // https://github.com/ollama/ollama/blob/f864601538bd283dbcd011244db99e2760b125c1/docs/api/cloud-usage.mdx#L95-L99
      usageUsd: totals.usage_usd === undefined ? null : number(totals.usage_usd, 'Ollama usage.totals.usage_usd'),
    },
  };
};
