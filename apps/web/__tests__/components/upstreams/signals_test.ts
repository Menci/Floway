import { describe, expect, it } from 'vitest';

import { currentUsage, kimiCodeRecord, legacyUsage } from './kimi-code-fixture';
import { creditBalance, legacyBalance, usageTotals } from './ollama-usage-fixture';
import type { UpstreamRecord } from '../../../src/api/types';
import { upstreamReadout } from '../../../src/components/upstreams/signals';
import en from '../../../src/i18n/locales/en';
import type { TFunction } from '../../../src/i18n/translation';

const OBSERVED = '2026-07-28T11:00:00.000Z';

// The real resources rather than a key echo, so the assertions read as the copy
// an operator sees and a key that does not exist fails here rather than
// rendering as itself.
const t = ((key: string, values?: Record<string, unknown>) => {
  const template = key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], en.translation);
  if (typeof template !== 'string') throw new Error(`Missing i18n key: ${key}`);
  return template.replace(/\{\{(\w+)[^}]*\}\}/g, (_, name: string) => String(values?.[name]));
}) as unknown as TFunction;

// Intl writes a narrow no-break space before a day-period (U+202F), which a
// literal expectation cannot spell readably; collapsing it keeps the assertion
// about the layout it is testing.
const normalizeSpaces = (value: string): string => value.replace(/\u202f/g, ' ');

const NOW = Date.parse('2026-07-28T12:00:00.000Z');
const readoutOf = (record: unknown, quotaDisplay: 'remaining' | 'used' = 'remaining') => upstreamReadout(record as UpstreamRecord, t, 'en', NOW, quotaDisplay);
const rowOf = (record: unknown) => {
  const { plan, signals } = readoutOf(record);
  return [plan, ...signals.map(signal => [signal.value, signal.label].filter(Boolean).join(' '))].join(' | ');
};

describe('upstream readout by provider', () => {
  it('reports Kimi Code quota independently of optional account details', () => {
    const record = kimiCodeRecord(currentUsage);
    expect(readoutOf(record, 'used')).toMatchObject({
      plan: 'Kimi Code', signals: [
        { key: 'five_hour', percent: 20, value: '20%', label: '5h' },
        { key: 'monthly', percent: 70, value: '70%', label: 'until Dec 1, 2026' },
      ],
    });
    expect(readoutOf(kimiCodeRecord(legacyUsage), 'remaining').signals.map(signal => [signal.key, signal.value, signal.label]))
      .toEqual([['five_hour', '90%', '5h'], ['weekly', '70%', '7d']]);
    record.state!.accountProbe = {
      attemptedAt: 1000, error: null,
      observation: { fetchedAt: 1000, data: { userId: 'fake-user', globalId: null, nickname: '', status: '', region: '', userLevel: 0, userLevelName: 'Pro', domain: 0, domainName: '', goodsVersion: null, username: null, email: null, bio: null, avatar: null, phone: null, createdTime: null, lastLoginTime: null } },
    };
    expect(readoutOf(record).plan).toBe('Kimi Pro');
    expect(readoutOf(kimiCodeRecord(null)).signals).toEqual([]);
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
    expect(rowOf(record)).toBe('Copilot | 71% until Sep 1, 2026');
    // The bucket's own name is what the row had no width for, so it is the tooltip,
    // one fact per line rather than a run the tooltip wraps on its own.
    const detail = readoutOf(record).signals[0].detail;
    expect(detail).not.toContain(' - ');
    expect(detail.split('\n').map(normalizeSpaces)).toEqual([
      'Allowance: 71% remaining',
      'Resets Sep 1, 2026, 12:00:00 AM',
      'Observed Jul 28, 2026, 11:00:00 AM',
    ]);
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
  it('states a ChatGPT rate limit last, as the time it still has to run', () => {
    const rowFor = (until: string) => rowOf({
      kind: 'chatgpt',
      config: { accounts: [{ chatgptAccountId: 'acct_1', planType: 'pro' }] },
      state: { accounts: [] },
      chatgpt_quota: {
        premium: { observed_at: OBSERVED, primary_used_percent: 12, primary_window_minutes: 300, ratelimited_until: until },
      },
    });

    expect(rowFor('2026-07-28T14:30:00.000Z')).toBe('ChatGPT Pro | 88% 5h | Rate limited 2h 30m');
    expect(rowFor('2026-07-28T12:45:00.000Z')).toBe('ChatGPT Pro | 88% 5h | Rate limited 45m');
    // A day out still reads in hours, and any time left never reads as none.
    expect(rowFor('2026-07-30T12:00:00.000Z')).toBe('ChatGPT Pro | 88% 5h | Rate limited 48h');
    expect(rowFor('2026-07-28T12:00:01.000Z')).toBe('ChatGPT Pro | 88% 5h | Rate limited 1m');
  });

  it('states a Claude Code shared refusal without promoting model limits to account limits', () => {
    const rowFor = (reset: string | null, representativeClaim: string | null = 'seven_day') => rowOf({
      kind: 'claude-code',
      config: { accounts: [{ accountUuid: 'uuid-1', subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' }] },
      state: {
        accounts: [{
          accountUuid: 'uuid-1',
          quotaSnapshot: { fetchedAt: Date.parse(OBSERVED), data: { status: 'rejected', reset, representativeClaim, raw: {} } },
        }],
      },
    });

    expect(rowFor('2026-07-28T15:00:00.000Z')).toBe('Claude Max 20x | Rate limited 3h');
    for (const claim of ['seven_day_overage_included', 'seven_day_opus', 'seven_day_sonnet', 'future_model_limit', null]) {
      expect(rowFor('2026-07-28T15:00:00.000Z', claim)).toBe('Claude Max 20x');
    }
    // The snapshot holds until a response replaces it, so a rejection whose
    // reset has passed is the steady state of an upstream serving again -- the
    // data plane stops gating on it at exactly this instant.
    expect(rowFor('2026-07-28T09:00:00.000Z')).toBe('Claude Max 20x');
    expect(rowFor('2026-07-28T12:00:00.000Z')).toBe('Claude Max 20x');
    // A refusal with no date is not one the router gates on either, so the row
    // does not contradict it by painting one.
    expect(rowFor(null)).toBe('Claude Max 20x');
  });

  it('carries the ChatGPT credit balance beside the windows', () => {
    const withCredits = (credits: Record<string, unknown>) => readoutOf({
      kind: 'chatgpt',
      config: { accounts: [{ chatgptAccountId: 'acct_1', planType: 'plus' }] },
      state: { accounts: [] },
      chatgpt_quota: { plus: { observed_at: OBSERVED, ...credits } },
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
    expect(rowOf(record)).toBe('Claude Max 20x | 75% 5h | 60% 7d | 92% 7d Sonnet');
  });

  // OpenAI renamed Team to Business without changing the wire identifier, and
  // groups `business` with its enterprise plans.
  it('names a ChatGPT plan as Codex itself displays it', () => {
    const planFor = (planType: string) => readoutOf({
      kind: 'chatgpt',
      config: { accounts: [{ chatgptAccountId: 'acct_1', planType }] },
      state: { accounts: [] },
    }).plan;

    expect(planFor('team')).toBe('ChatGPT Business');
    expect(planFor('business')).toBe('ChatGPT Enterprise');
    expect(planFor('prolite')).toBe('ChatGPT Pro Lite');
  });

  const ollamaRecord = (data: unknown) => ({ kind: 'ollama', state: { account: { plan: 'pro' }, usageProbe: { observation: { fetchedAt: Date.parse(OBSERVED), data } } } });

  it('keeps legacy percentage signals while using current balance reset times', () => {
    const record = ollamaRecord({ balance: legacyBalance, usage: { ...usageTotals, totals: { request_count: 15 } } });
    expect(rowOf(record)).toBe('Ollama Pro | 75% 5h | 60% 7d');
    expect(readoutOf(record).signals[0]?.detail).toContain('Oct 11, 2026');
  });

  it('shows remaining plan credits against their period allowance', () => {
    const record = ollamaRecord({ balance: creditBalance, usage: usageTotals });
    expect(rowOf(record)).toBe('Ollama Pro | 30% $18.00 / $60.00');
    expect(upstreamReadout(record as never, t, 'en', NOW, 'used').signals[0]?.label).toBe('$42.00 / $60.00');
    expect(readoutOf(record).signals[0]?.percent).toBe(70);
    expect(readoutOf(record).signals[0]?.detail).toContain('Oct 1, 2026 to Nov 1, 2026: plan credits used this period.');
  });

  it('derives subscription usage from its own period when activity spans a reset', () => {
    const signals = readoutOf(ollamaRecord({
      balance: { ...creditBalance, included: { ...creditBalance.included, balance_usd: 57, period: { from: '2026-11-01T00:00:00Z', until: '2026-12-01T00:00:00Z' } } },
      usage: { ...usageTotals, from: '2026-10-27T00:00:00Z', until: '2026-11-03T04:00:00Z', totals: { request_count: 15, usage_usd: 10 } },
    })).signals;
    expect(signals).toHaveLength(1);
    expect(signals[0]?.value).toBe('95%');
    expect(signals[0]?.label).toBe('$57.00 / $60.00');
    expect(signals[0]?.percent).toBe(5);
    expect(signals[0]?.detail).toContain('Nov 1, 2026 to Dec 1, 2026: plan credits used this period.');
  });
});

describe('quota direction preference', () => {
  const copilot = {
    kind: 'copilot',
    state: {
      quotaSnapshot: {
        data: {
          observed_at: OBSERVED,
          reset_at: null,
          quotas: {
            premium_interactions: { entitlement: 300, quota_remaining: 213, percent_remaining: 71, overage_count: 0, overage_permitted: true, unlimited: false },
          },
        },
      },
    },
  };

  it('reads the same reading as remaining by default and as used on request', () => {
    expect(rowOf(copilot)).toBe('Copilot | 71%');
    const used = upstreamReadout(copilot as never, t, 'en', NOW, 'used').signals[0]!;
    const remaining = upstreamReadout(copilot as never, t, 'en', NOW, 'remaining').signals[0]!;
    expect(used.value).toBe('29%');
    expect(remaining.value).toBe('71%');
    // The severity is a property of the reading, not of the direction shown.
    expect(used.percent).toBe(29);
    expect(remaining.percent).toBe(29);
  });
});
