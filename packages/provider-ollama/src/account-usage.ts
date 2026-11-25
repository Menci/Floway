import type { Result } from '@floway-dev/pipeline';

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
  activity: { range: string; scope: string; from: string; until: string; usageUsd: number | null };
}

const object = (value: unknown, path: string): Result<Record<string, unknown>, TypeError> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, error: new TypeError(`${path} must be an object`) };
  return { ok: true, value: value as Record<string, unknown> };
};

const number = (value: unknown, path: string): Result<number, TypeError> => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, error: new TypeError(`${path} must be a finite number`) };
  return { ok: true, value };
};

const string = (value: unknown, path: string): Result<string, TypeError> => {
  if (typeof value !== 'string' || value.length === 0) return { ok: false, error: new TypeError(`${path} must be a nonempty string`) };
  return { ok: true, value };
};

const timestamp = (value: unknown, path: string): Result<string, TypeError> => {
  const result = string(value, path);
  if (result.ok && !Number.isFinite(Date.parse(result.value))) return { ok: false, error: new TypeError(`${path} must be a timestamp`) };
  return result;
};

const window = (value: unknown, path: string): Result<OllamaUsageWindow, TypeError | RangeError> => {
  const body = object(value, path);
  if (!body.ok) return body;
  const remainingPercent = number(body.value.remaining_percent, `${path}.remaining_percent`);
  if (!remainingPercent.ok) return remainingPercent;
  if (remainingPercent.value < 0 || remainingPercent.value > 100) return { ok: false, error: new RangeError(`${path}.remaining_percent must be between 0 and 100`) };
  const resetsAt = timestamp(body.value.resets_at, `${path}.resets_at`);
  return resetsAt.ok ? { ok: true, value: { remainingPercent: remainingPercent.value, resetsAt: resetsAt.value } } : resetsAt;
};

// Legacy plans remain supported by /api/balance, independently of the new
// /api/usage response. Plan names such as Pro do not distinguish billing modes.
// https://github.com/ollama/ollama/blob/f864601538bd283dbcd011244db99e2760b125c1/docs/openapi.yaml#L1089-L1156
export const parseOllamaAccountUsage = (value: unknown): Result<OllamaAccountUsage, TypeError | RangeError> => {
  const body = object(value, 'Ollama account usage');
  if (!body.ok) return body;
  const balance = object(body.value.balance, 'Ollama balance');
  if (!balance.ok) return balance;
  const included = object(balance.value.included, 'Ollama balance.included');
  if (!included.ok) return included;
  const credits = Object.hasOwn(included.value, 'balance_usd');
  const legacy = Object.hasOwn(included.value, 'session') || Object.hasOwn(included.value, 'weekly');
  if (credits === legacy) return { ok: false, error: new TypeError('Ollama balance.included must describe either credits or legacy limits') };
  let allowance: OllamaAccountUsage['included'];
  if (credits) {
    const period = object(included.value.period, 'Ollama balance.included.period');
    if (!period.ok) return period;
    const balanceUsd = number(included.value.balance_usd, 'Ollama balance.included.balance_usd');
    if (!balanceUsd.ok) return balanceUsd;
    const allowanceUsd = number(included.value.allowance_usd, 'Ollama balance.included.allowance_usd');
    if (!allowanceUsd.ok) return allowanceUsd;
    const from = timestamp(period.value.from, 'Ollama balance.included.period.from');
    if (!from.ok) return from;
    const until = timestamp(period.value.until, 'Ollama balance.included.period.until');
    if (!until.ok) return until;
    allowance = {
      kind: 'credits', balanceUsd: balanceUsd.value, allowanceUsd: allowanceUsd.value, from: from.value, until: until.value,
    };
  } else {
    const session = window(included.value.session, 'Ollama balance.included.session');
    if (!session.ok) return session;
    const weekly = window(included.value.weekly, 'Ollama balance.included.weekly');
    if (!weekly.ok) return weekly;
    allowance = { kind: 'legacy', session: session.value, weekly: weekly.value };
  }
  const purchased = object(balance.value.purchased, 'Ollama balance.purchased');
  if (!purchased.ok) return purchased;
  const usage = object(body.value.usage, 'Ollama usage');
  if (!usage.ok) return usage;
  const totals = object(usage.value.totals, 'Ollama usage.totals');
  if (!totals.ok) return totals;
  const requestCount = number(totals.value.request_count, 'Ollama usage.totals.request_count');
  if (!requestCount.ok) return requestCount;
  if (!Number.isSafeInteger(requestCount.value) || requestCount.value < 0) return { ok: false, error: new RangeError('Ollama usage.totals.request_count must be a nonnegative integer') };
  const purchasedBalanceUsd = number(purchased.value.balance_usd, 'Ollama balance.purchased.balance_usd');
  if (!purchasedBalanceUsd.ok) return purchasedBalanceUsd;
  const range = string(usage.value.range, 'Ollama usage.range');
  if (!range.ok) return range;
  const scope = string(usage.value.scope, 'Ollama usage.scope');
  if (!scope.ok) return scope;
  const from = timestamp(usage.value.from, 'Ollama usage.from');
  if (!from.ok) return from;
  const until = timestamp(usage.value.until, 'Ollama usage.until');
  if (!until.ok) return until;
  // Legacy requests omit monetary totals; absence is not a zero reading.
  // https://github.com/ollama/ollama/blob/f864601538bd283dbcd011244db99e2760b125c1/docs/api/cloud-usage.mdx#L95-L99
  const usageUsd = totals.value.usage_usd === undefined ? { ok: true, value: null } as const : number(totals.value.usage_usd, 'Ollama usage.totals.usage_usd');
  if (!usageUsd.ok) return usageUsd;
  return {
    ok: true, value: {
      included: allowance, purchasedBalanceUsd: purchasedBalanceUsd.value,
      activity: {
        range: range.value, scope: scope.value, from: from.value, until: until.value, usageUsd: usageUsd.value,
      },
    },
  };
};

export const readOllamaAccountUsage = (value: unknown): OllamaAccountUsage => {
  const parsed = parseOllamaAccountUsage(value);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
};
