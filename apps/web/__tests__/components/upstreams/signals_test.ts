import { describe, expect, it } from 'vitest';

import type { UpstreamRecord } from '../../../src/api/types';
import { upstreamReadout } from '../../../src/components/upstreams/signals';
import en from '../../../src/i18n/locales/en';
import type { TFunction } from '../../../src/i18n/translation';

const NOW = Date.parse('2026-07-28T12:00:00.000Z');
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
    expect(withCredits({ credits_has_credits: false })).toEqual(['No credits']);
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
      state: { account: { fetchedAt: Date.parse(OBSERVED), plan } },
    }).plan;

    expect(planFor('max')).toBe('Ollama Max');
    // The identifiers are plain words, so one this table has not seen reads as
    // itself rather than as nothing.
    expect(planFor('enterprise')).toBe('Ollama enterprise');
    expect(planFor(null)).toBe('Ollama');
  });

  it('reads the Ollama Cloud windows and the activity cost the probe stored', () => {
    const record = {
      kind: 'ollama',
      state: {
        account: { fetchedAt: Date.parse(OBSERVED), plan: 'pro' },
        usageProbe: {
          attemptedAt: Date.parse(OBSERVED), error: null, observation: {
            fetchedAt: Date.parse(OBSERVED),
            data: { activity: { cost: '24.34000' }, limits: { session: { usage: 0.25 }, weekly: { usage: 0.4 } } },
          },
        },
      },
    };
    expect(rowOf(record)).toBe('Ollama Pro | 25% 5h | 40% 7d | $24.34');
  });

  it('shows an Ollama Cloud account that has spent nothing as zero rather than as unreported', () => {
    expect(rowOf({
      kind: 'ollama',
      state: {
        usageProbe: {
          attemptedAt: Date.parse(OBSERVED), error: null, observation: {
            fetchedAt: Date.parse(OBSERVED),
            data: { activity: { cost: '0.00000' }, limits: {} },
          },
        },
      },
    })).toBe('Ollama | $0');
  });

  it('reports nothing for a self-hosted Ollama, which serves no usage endpoint', () => {
    expect(readoutOf({ kind: 'ollama', state: null })).toEqual({ plan: 'Ollama', signals: [] });
  });
});
