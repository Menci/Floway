import { describe, expect, it } from 'vitest';

import { currentUsage, kimiCodeRecord, legacyUsage } from './kimi-code-fixture';
import { creditBalance, usageTotals } from './ollama-usage-fixture';
import type { UpstreamRecord } from '../../../src/api/types';
import { upstreamReadout } from '../../../src/components/upstreams/signals';
import en from '../../../src/i18n/locales/en';
import type { TFunction } from '../../../src/i18n/translation';

const OBSERVED = '2026-07-28T11:00:00.000Z';

// The real resources rather than a key echo, so a key that does not exist
// fails here rather than rendering as itself.
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
const RATE_LIMITED = t('dashboard.upstreams.signals.rateLimited');
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
    const lines = detail.split('\n').map(normalizeSpaces);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('71%');
    expect(lines[1]).toContain('Sep 1, 2026, 12:00:00 AM');
    expect(lines[2]).toContain('Jul 28, 2026, 11:00:00 AM');
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

    expect(rowFor('2026-07-28T14:30:00.000Z')).toBe(`ChatGPT Pro | 88% 5h | ${RATE_LIMITED} 2h 30m`);
    expect(rowFor('2026-07-28T12:45:00.000Z')).toBe(`ChatGPT Pro | 88% 5h | ${RATE_LIMITED} 45m`);
    // A day out still reads in hours, and any time left never reads as none.
    expect(rowFor('2026-07-30T12:00:00.000Z')).toBe(`ChatGPT Pro | 88% 5h | ${RATE_LIMITED} 48h`);
    expect(rowFor('2026-07-28T12:00:01.000Z')).toBe(`ChatGPT Pro | 88% 5h | ${RATE_LIMITED} 1m`);
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

    expect(rowFor('2026-07-28T15:00:00.000Z')).toBe(`Claude Max 20x | ${RATE_LIMITED} 3h`);
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

  const ollamaRecord = (data: unknown) => ({ kind: 'ollama', state: { account: { plan: 'pro' }, usageProbe: { observation: { fetchedAt: Date.parse(OBSERVED), data } } } });

  it('shows remaining plan credits against their period allowance', () => {
    const record = ollamaRecord({ balance: creditBalance, usage: usageTotals });
    expect(rowOf(record)).toBe('Ollama Pro | 30% $18.00 / $60.00');
    expect(upstreamReadout(record as never, t, 'en', NOW, 'used').signals[0]?.label).toBe('$42.00 / $60.00');
    expect(readoutOf(record).signals[0]?.percent).toBe(70);
    expect(readoutOf(record).signals[0]?.detail).toContain('Oct 1, 2026');
    expect(readoutOf(record).signals[0]?.detail).toContain('Nov 1, 2026');
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
