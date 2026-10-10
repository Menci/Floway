import { describe, expect, it } from 'vitest';

import { creditBalance, legacyBalance, usageTotals } from './ollama-usage-fixture';
import type { UpstreamRecord } from '../../../src/api/types';
import { upstreamReadout } from '../../../src/components/upstreams/signals';
import en from '../../../src/i18n/locales/en';
import type { TFunction } from '../../../src/i18n/translation';

const OBSERVED = '2026-07-28T11:00:00.000Z';

// The real resources rather than a key echo, so the assertions read as the copy
// an operator sees and a key that does not exist fails here rather than
// rendering as itself.
const resolve = (key: string): unknown =>
  key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], en.translation);

const t = ((key: string, values?: Record<string, unknown>) => {
  const template = resolve(key);
  if (typeof template !== 'string') throw new Error(`Missing i18n key: ${key}`);
  return template.replace(/\{\{(\w+)[^}]*\}\}/g, (_, name: string) => String(values?.[name]));
}) as unknown as TFunction;

const NOW = Date.parse('2026-07-28T12:00:00.000Z');
const readoutOf = (record: unknown) => upstreamReadout(record as UpstreamRecord, t, 'en', NOW);
const rowOf = (record: unknown) => {
  const { plan, signals } = readoutOf(record);
  return [plan, ...signals.map(signal => [signal.value, signal.label].filter(Boolean).join(' '))].join(' | ');
};

describe('upstream readout by provider', () => {
  it('names the provider itself when the upstream publishes nothing about its account', () => {
    expect(readoutOf({ kind: 'custom', config: { baseUrl: 'https://api.openai.com' } }))
      .toEqual({ plan: 'Custom', signals: [] });
    expect(readoutOf({ kind: 'azure', config: { endpoint: 'https://x.openai.azure.com' } }))
      .toEqual({ plan: 'Azure', signals: [] });
  });

  it('meters only the Copilot buckets that are capped, and dates them by the seat reset', () => {
    const record = {
      kind: 'copilot',
      state: {
        quotaSnapshot: {
          data: {
            observed_at: OBSERVED,
            reset_at: '2026-09-01T00:00:00.000Z',
            quotas: {
              chat: { entitlement: -1, quota_remaining: -1, percent_remaining: 100, overage_count: 0, overage_permitted: false, unlimited: true },
              premium_interactions: { entitlement: 300, quota_remaining: 213, percent_remaining: 71, overage_count: 0, overage_permitted: true, unlimited: false },
            },
          },
        },
      },
    };
    expect(rowOf(record)).toBe('Copilot | 29% until Sep 1, 2026');
    // The bucket's own name is what the row had no width for, so it is the tooltip.
    expect(readoutOf(record).signals[0].detail).toContain('premium interactions: 29% used');
  });

  it('names the Copilot seat the way VS Code names it', () => {
    const planFor = (plan: string | null, sku: string | null) => readoutOf({
      kind: 'copilot',
      state: { seat: { fetchedAt: Date.parse(OBSERVED), data: { observed_at: OBSERVED, plan, sku } } },
    }).plan;

    expect(planFor('individual_pro', null)).toBe('Copilot Pro+');
    expect(planFor('individual_max', null)).toBe('Copilot Max');
    expect(planFor('business', null)).toBe('Copilot Business');
    // A live enterprise seat: the plan names it, and its SKU is one no table needs.
    expect(planFor('enterprise', 'copilot_enterprise_seat_quota')).toBe('Copilot Enterprise');
    // The SKU is matched first, because a free seat carries no plan of its own.
    expect(planFor(null, 'free_limited_copilot')).toBe('Copilot Free');
    expect(planFor('individual', 'free_educational_quota')).toBe('Copilot Student');
    // Both namespaces are open, so an unknown value names no plan.
    expect(planFor('individual_ultra', null)).toBe('Copilot');
    expect(planFor(null, null)).toBe('Copilot');
  });

  // A rate limit and a spent window are different facts: the row states the
  // limit rather than inferring it from a percentage that can read low while it
  // holds, and states how long the wait still has to run rather than when it
  // ends. Hours are the largest unit it uses.
  it('states a Codex rate limit last, as the time it still has to run', () => {
    const rowFor = (until: string) => rowOf({
      kind: 'codex',
      config: { accounts: [{ chatgptAccountId: 'acct_1', planType: 'pro' }] },
      state: { accounts: [] },
      codex_quota: {
        premium: { observed_at: OBSERVED, primary_used_percent: 12, primary_window_minutes: 300, ratelimited_until: until },
      },
    });

    expect(rowFor('2026-07-28T14:30:00.000Z')).toBe('ChatGPT Pro | 12% 5h | Rate limited 2h 30m');
    expect(rowFor('2026-07-28T12:45:00.000Z')).toBe('ChatGPT Pro | 12% 5h | Rate limited 45m');
    // A day out still reads in hours, and any time left never reads as none.
    expect(rowFor('2026-07-30T12:00:00.000Z')).toBe('ChatGPT Pro | 12% 5h | Rate limited 48h');
    expect(rowFor('2026-07-28T12:00:01.000Z')).toBe('ChatGPT Pro | 12% 5h | Rate limited 1m');
  });

  it('lets an elapsed Codex rate limit go rather than holding it on the row', () => {
    expect(rowOf({
      kind: 'codex',
      config: { accounts: [{ chatgptAccountId: 'acct_1', planType: 'pro' }] },
      state: { accounts: [] },
      codex_quota: { premium: { observed_at: OBSERVED, primary_used_percent: 12, primary_window_minutes: 300, ratelimited_until: '2020-01-01T00:00:00.000Z' } },
    })).toBe('ChatGPT Pro | 12% 5h');
  });

  it('states a Claude Code refusal from the status Anthropic reports it under', () => {
    const rowFor = (reset: string | null) => rowOf({
      kind: 'claude-code',
      config: { accounts: [{ accountUuid: 'uuid-1', subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' }] },
      state: {
        accounts: [{
          accountUuid: 'uuid-1',
          quotaSnapshot: { fetchedAt: Date.parse(OBSERVED), data: { status: 'rejected', reset, raw: {} } },
        }],
      },
    });

    expect(rowFor('2026-07-28T15:00:00.000Z')).toBe('Claude Max 20x | Rate limited 3h');
    // The snapshot holds until a response replaces it, so a rejection whose
    // reset has passed is the steady state of an upstream serving again -- the
    // data plane stops gating on it at exactly this instant.
    expect(rowFor('2026-07-28T09:00:00.000Z')).toBe('Claude Max 20x');
    expect(rowFor('2026-07-28T12:00:00.000Z')).toBe('Claude Max 20x');
    // A refusal with no date is not one the router gates on either, so the row
    // does not contradict it by painting one.
    expect(rowFor(null)).toBe('Claude Max 20x');
  });

  it('reports nothing for a Copilot seat no response has been observed on', () => {
    expect(readoutOf({ kind: 'copilot', state: null })).toEqual({ plan: 'Copilot', signals: [] });
  });

  it('names a Codex window by the length its header states, under the ChatGPT plan', () => {
    const record = {
      kind: 'codex',
      config: { accounts: [{ chatgptAccountId: 'acct_1', planType: 'pro' }] },
      state: { accounts: [] },
      codex_quota: {
        pro: {
          observed_at: OBSERVED,
          primary_used_percent: 25, primary_window_minutes: 300,
          secondary_used_percent: 40, secondary_window_minutes: 10_080,
        },
      },
    };
    expect(rowOf(record)).toBe('ChatGPT Pro | 25% 5h | 40% 7d');
  });

  it('forwards a ChatGPT plan this dashboard has not seen', () => {
    expect(readoutOf({
      kind: 'codex',
      config: { accounts: [{ chatgptAccountId: 'acct_1', planType: 'ultra' }] },
      state: { accounts: [] },
    }).plan).toBe('ChatGPT ultra');
  });

  it('falls back to a Codex window position when no length came with it', () => {
    const record = {
      kind: 'codex',
      config: { accounts: [{ chatgptAccountId: 'acct_1', planType: 'plus' }] },
      state: { accounts: [] },
      codex_quota: { plus: { observed_at: OBSERVED, primary_used_percent: 25 } },
    };
    expect(rowOf(record)).toBe('ChatGPT Plus | 25% Primary');
  });

  it('states the Codex limit observed last rather than every key the map holds', () => {
    const record = {
      kind: 'codex',
      config: { accounts: [{ chatgptAccountId: 'acct_1', planType: 'plus' }] },
      state: { accounts: [] },
      codex_quota: {
        stale: { observed_at: '2026-07-20T00:00:00.000Z', primary_used_percent: 90, primary_window_minutes: 300 },
        current: { observed_at: OBSERVED, primary_used_percent: 12, primary_window_minutes: 300 },
      },
    };
    expect(rowOf(record)).toBe('ChatGPT Plus | 12% 5h');
  });

  it('carries the Codex credit balance beside the windows', () => {
    const withCredits = (credits: Record<string, unknown>) => readoutOf({
      kind: 'codex',
      config: { accounts: [{ chatgptAccountId: 'acct_1', planType: 'plus' }] },
      state: { accounts: [] },
      codex_quota: { plus: { observed_at: OBSERVED, ...credits } },
    }).signals.map(signal => signal.value);

    expect(withCredits({ credits_has_credits: true, credits_balance: 42 })).toEqual(['42 credits']);
    // A balance of nothing says nothing on this line, however the account
    // reports it -- the editor card is where both still show.
    expect(withCredits({ credits_has_credits: true, credits_balance: 0 })).toEqual([]);
    expect(withCredits({ credits_has_credits: false })).toEqual([]);
    expect(withCredits({ credits_has_credits: false, credits_balance: 12 })).toEqual([]);
    expect(withCredits({})).toEqual([]);
  });

  it('lifts the Max multiple onto the Claude plan and tells the two seven-day windows apart', () => {
    const record = {
      kind: 'claude-code',
      config: { accounts: [{ accountUuid: 'uuid-1', subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' }] },
      state: {
        accounts: [{
          accountUuid: 'uuid-1',
          usageProbeSnapshot: {
            fetchedAt: Date.parse(OBSERVED),
            data: {
              five_hour: { utilization: 25, resets_at: '2026-07-28T15:00:00.000Z' },
              seven_day: { utilization: 40, resets_at: '2026-08-02T00:00:00.000Z' },
              seven_day_sonnet: { utilization: 8, resets_at: '2026-08-02T00:00:00.000Z' },
            },
          },
        }],
      },
    };
    expect(rowOf(record)).toBe('Claude Max 20x | 25% 5h | 40% 7d | 8% 7d Sonnet');
  });

  it('names a Claude subscription that carries no multiple by the subscription alone', () => {
    expect(readoutOf({
      kind: 'claude-code',
      config: { accounts: [{ accountUuid: 'uuid-1', subscriptionType: 'pro', rateLimitTier: 'default_claude_ai' }] },
      state: { accounts: [] },
    }).plan).toBe('Claude Pro');
  });

  // A Team premium seat carries `default_claude_max_5x`, which is not a Max
  // multiple and would otherwise render as a plan Anthropic does not sell.
  it('reads a Max multiple only under a Max subscription', () => {
    const planFor = (subscriptionType: string, rateLimitTier: string) => readoutOf({
      kind: 'claude-code',
      config: { accounts: [{ accountUuid: 'uuid-1', subscriptionType, rateLimitTier }] },
      state: { accounts: [] },
    }).plan;

    expect(planFor('team', 'default_claude_max_5x')).toBe('Claude Team');
    expect(planFor('max', 'default_claude_max_5x')).toBe('Claude Max 5x');
    expect(planFor('max', 'default_raven')).toBe('Claude Max');
  });

  // OpenAI renamed Team to Business without changing the wire identifier, and
  // groups `business` with its enterprise plans.
  it('names a ChatGPT plan as Codex itself displays it', () => {
    const planFor = (planType: string) => readoutOf({
      kind: 'codex',
      config: { accounts: [{ chatgptAccountId: 'acct_1', planType }] },
      state: { accounts: [] },
    }).plan;

    expect(planFor('team')).toBe('ChatGPT Business');
    expect(planFor('business')).toBe('ChatGPT Enterprise');
    expect(planFor('prolite')).toBe('ChatGPT Pro Lite');
  });

  it('names the Ollama Cloud account by the plan the probe read', () => {
    const planFor = (plan: string | null) => readoutOf({
      kind: 'ollama',
      state: { account: { fetchedAt: Date.parse(OBSERVED), plan, name: null, email: null } },
    }).plan;

    expect(planFor('max')).toBe('Ollama Max');
    expect(planFor('enterprise')).toBe('Ollama Enterprise');
    // The identifiers are plain words, so one this table has not seen reads as
    // itself rather than as nothing.
    expect(planFor('ultra')).toBe('Ollama ultra');
    expect(planFor(null)).toBe('Ollama');
  });

  const ollamaRecord = (data: unknown) => ({ kind: 'ollama', state: { account: { plan: 'pro' }, usageProbe: { observation: { fetchedAt: Date.parse(OBSERVED), data } } } });

  it('keeps legacy percentage signals while using current balance reset times', () => {
    const record = ollamaRecord({ balance: legacyBalance, usage: { ...usageTotals, totals: { request_count: 15 } } });
    expect(rowOf(record)).toBe('Ollama Pro | 25% 5h | 40% 7d');
    expect(readoutOf(record).signals[0]?.detail).toContain('Oct 11, 2026');
  });

  it('shows current consumption without adding monthly balances to the list', () => {
    const record = ollamaRecord({ balance: creditBalance, usage: usageTotals });
    expect(rowOf(record)).toBe('Ollama Pro | $3.25');
    expect(readoutOf(record).signals[0]?.detail).toBe('Oct 4, 2026 to Oct 11, 2026: credits this account consumed through model requests, including plan and purchased credits.');
  });

  it('keeps the consumption reporting interval independent of the monthly balance period', () => {
    const signals = readoutOf(ollamaRecord({
      balance: { ...creditBalance, included: { ...creditBalance.included, balance_usd: 57, period: { from: '2026-11-01T00:00:00Z', until: '2026-12-01T00:00:00Z' } } },
      usage: { ...usageTotals, from: '2026-10-27T00:00:00Z', until: '2026-11-03T04:00:00Z', totals: { request_count: 15, usage_usd: 10 } },
    })).signals;
    expect(signals).toHaveLength(1);
    expect(signals[0]?.value).toBe('$10.00');
    expect(signals[0]?.detail).toBe('Oct 27, 2026 to Nov 3, 2026: credits this account consumed through model requests, including plan and purchased credits.');
  });

  it('leaves zero consumption off the list while retaining legacy percentages', () => {
    expect(rowOf(ollamaRecord({ balance: legacyBalance, usage: { ...usageTotals, totals: { request_count: 15, usage_usd: 0 } } }))).toBe('Ollama Pro | 25% 5h | 40% 7d');
  });

  it('reports nothing for a self-hosted Ollama, which serves no usage endpoint', () => {
    expect(readoutOf({ kind: 'ollama', state: null })).toEqual({ plan: 'Ollama', signals: [] });
  });
});
