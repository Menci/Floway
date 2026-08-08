import { describe, expect, it } from 'vitest';

import type { UpstreamRecord } from '../../../src/api/types';
import { upstreamSignals } from '../../../src/components/upstreams/signals';
import type { TFunction } from '../../../src/i18n/translation';

const NOW = Date.parse('2026-07-28T12:00:00.000Z');
const OBSERVED = '2026-07-28T11:00:00.000Z';

// The projection is asserted on what a row shows, so the stub answers with the
// key and lets the interpolated values through unchanged.
const t = ((key: string, values?: Record<string, unknown>) =>
  values === undefined ? key : `${key}(${JSON.stringify(values)})`) as unknown as TFunction;

const signalsOf = (record: unknown) => upstreamSignals(record as UpstreamRecord, t, 'en', NOW);
const meters = (record: unknown) => signalsOf(record)
  .filter(signal => signal.kind === 'meter')
  .map(signal => ({ label: signal.label, percent: signal.percent }));

describe('upstream signals by provider', () => {
  it('reports no signals for an endpoint that publishes no account of its own', () => {
    expect(signalsOf({ kind: 'custom', config: { baseUrl: 'https://api.openai.com' } })).toEqual([]);
    expect(signalsOf({ kind: 'azure', config: { endpoint: 'https://x.openai.azure.com' } })).toEqual([]);
  });

  it('meters only the Copilot buckets that are capped, under the id GitHub sent', () => {
    const record = {
      kind: 'copilot',
      state: {
        quotaSnapshot: {
          data: {
            observed_at: OBSERVED,
            reset_at: '2026-08-01T00:00:00.000Z',
            quotas: {
              chat: { entitlement: -1, quota_remaining: -1, percent_remaining: 100, overage_count: 0, overage_permitted: false, unlimited: true },
              premium_interactions: { entitlement: 300, quota_remaining: 213, percent_remaining: 71, overage_count: 0, overage_permitted: true, unlimited: false },
            },
          },
        },
      },
    };
    expect(meters(record)).toEqual([{ label: 'premium interactions', percent: 29 }]);
  });

  it('reports nothing for a Copilot seat no response has been observed on', () => {
    expect(signalsOf({ kind: 'copilot', state: null })).toEqual([]);
  });

  it('names a Codex window by the length its header states', () => {
    const record = {
      kind: 'codex',
      config: { accounts: [{ chatgptAccountId: 'acct_1' }] },
      state: { accounts: [] },
      codex_quota: {
        plus: {
          observed_at: OBSERVED,
          primary_used_percent: 25, primary_window_minutes: 300,
          secondary_used_percent: 40, secondary_window_minutes: 10_080,
        },
      },
    };
    expect(meters(record)).toEqual([{ label: '5h', percent: 25 }, { label: '7d', percent: 40 }]);
  });

  it('falls back to a Codex window position when no length came with it', () => {
    const record = {
      kind: 'codex',
      config: { accounts: [{ chatgptAccountId: 'acct_1' }] },
      state: { accounts: [] },
      codex_quota: { plus: { observed_at: OBSERVED, primary_used_percent: 25 } },
    };
    expect(meters(record)[0].label).toBe('dashboard.upstreams.signals.window.primary');
  });

  it('states the Codex limit observed last rather than every key the map holds', () => {
    const record = {
      kind: 'codex',
      config: { accounts: [{ chatgptAccountId: 'acct_1' }] },
      state: { accounts: [] },
      codex_quota: {
        stale: { observed_at: '2026-07-20T00:00:00.000Z', primary_used_percent: 90, primary_window_minutes: 300 },
        current: { observed_at: OBSERVED, primary_used_percent: 12, primary_window_minutes: 300 },
      },
    };
    expect(meters(record)).toEqual([{ label: '5h', percent: 12 }]);
  });

  it('carries the Codex credit balance beside the windows', () => {
    const withCredits = (credits: Record<string, unknown>) => signalsOf({
      kind: 'codex',
      config: { accounts: [{ chatgptAccountId: 'acct_1' }] },
      state: { accounts: [] },
      codex_quota: { plus: { observed_at: OBSERVED, ...credits } },
    }).filter(signal => signal.kind === 'amount');

    expect(withCredits({ credits_has_credits: true, credits_balance: 42 })[0].text)
      .toBe('dashboard.upstreams.signals.credits({"balance":42})');
    expect(withCredits({ credits_has_credits: false })[0].text)
      .toBe('dashboard.upstreams.signals.noCredits');
    expect(withCredits({})).toEqual([]);
  });

  it('names the Claude Code windows by length and tells the two seven-day ones apart', () => {
    const record = {
      kind: 'claude-code',
      config: { accounts: [{ accountUuid: 'uuid-1' }] },
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
    expect(meters(record)).toEqual([
      { label: '5h', percent: 25 },
      { label: '7d', percent: 40 },
      { label: '7d Sonnet', percent: 8 },
    ]);
  });

  it('reads the Ollama Cloud windows and the activity cost the probe stored', () => {
    const record = {
      kind: 'ollama',
      state: {
        usageProbe: {
          attemptedAt: Date.parse(OBSERVED), error: null, observation: {
            fetchedAt: Date.parse(OBSERVED),
            data: { activity: { cost: '24.34000' }, limits: { session: { usage: 0.25 }, weekly: { usage: 0.4 } } },
          },
        },
      },
    };
    expect(meters(record)).toEqual([{ label: '5h', percent: 25 }, { label: '7d', percent: 40 }]);
    expect(signalsOf(record).filter(signal => signal.kind === 'amount')[0].text).toBe('$24.34');
  });

  it('shows an Ollama Cloud account that has spent nothing as zero rather than as unreported', () => {
    const signals = signalsOf({
      kind: 'ollama',
      state: {
        usageProbe: {
          attemptedAt: Date.parse(OBSERVED), error: null, observation: {
            fetchedAt: Date.parse(OBSERVED),
            data: { activity: { cost: '0.00000' }, limits: {} },
          },
        },
      },
    });
    expect(signals).toHaveLength(1);
    expect(signals[0].kind === 'amount' && signals[0].text).toBe('$0');
  });

  it('reports nothing for a self-hosted Ollama, which serves no usage endpoint', () => {
    expect(signalsOf({ kind: 'ollama', state: null })).toEqual([]);
  });
});
