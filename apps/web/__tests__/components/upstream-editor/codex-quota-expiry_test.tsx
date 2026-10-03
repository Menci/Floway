import { act, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CodexAccountCard } from '../../../src/components/upstream-editor/codex-account-card';
import type { CodexRecord } from '../../../src/components/upstreams/codex-account';
import { UpstreamSignals } from '../../../src/components/upstreams/signals';
import { upstreamRecord } from '../../api/upstream-fixture';
import { stubLocalStorage } from '../../local-storage-stub';
import { renderInApp } from '../../render';

stubLocalStorage();

const observed = '2026-07-28T11:00:00.000Z';
const primaryReset = '2026-07-28T13:00:00.000Z';
const secondaryReset = '2026-08-01T12:00:00.000Z';
const record = upstreamRecord('', {
  kind: 'codex',
  config: { accounts: [{ email: 'fixture@example.com', chatgptAccountId: 'fixture', chatgptUserId: 'fixture', planType: 'plus' }] },
  state: { accounts: [{ chatgptAccountId: 'fixture', state: 'active', state_updated_at: observed }] },
}) as CodexRecord;

// Control-plane projections retain observed usage and date only known exhausted windows.
const cases = [
  { name: 'primary only', primary: 100, secondary: 35, until: primaryReset },
  { name: 'secondary only', primary: 35, secondary: 100, until: secondaryReset },
  { name: 'both known', primary: 100, secondary: 100, until: secondaryReset },
  { name: 'unknown secondary percentage', primary: 100, secondary: undefined, until: primaryReset },
  { name: 'exhausted secondary without reset', primary: 100, secondary: 100, secondaryReset: undefined, until: primaryReset },
  { name: 'unknown primary percentage', primary: undefined, secondary: 100, until: secondaryReset },
];

afterEach(() => vi.useRealTimers());

describe('Codex projected quota on list and card', () => {
  it.each(cases)('expires the known timer without new traffic: $name', async ({ primary, secondary, until, ...scenario }) => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-07-28T12:00:00.000Z');
    const quota = {
      observed_at: observed,
      active_limit: 'premium',
      primary_used_percent: primary,
      primary_window_minutes: 300,
      primary_reset_after_at: primaryReset,
      secondary_used_percent: secondary,
      secondary_window_minutes: 10_080,
      secondary_reset_after_at: 'secondaryReset' in scenario ? scenario.secondaryReset : secondaryReset,
      ratelimited_until: until,
    };
    const projected = { ...record, codex_quota: { premium: quota } };
    const view = renderInApp(<><div data-testid="list"><UpstreamSignals record={projected} /></div><div data-testid="card"><CodexAccountCard record={projected} /></div></>);
    const list = within(screen.getByTestId('list'));
    const card = within(screen.getByTestId('card'));
    expect(list.getByText('Rate limited')).toBeTruthy();
    expect(card.getAllByText(/^Rate-limited until/)).toHaveLength(2);

    // Passing the short reset must not clear a genuine later exhausted window.
    await act(async () => {
      vi.setSystemTime(Date.parse(primaryReset) + 1);
      vi.advanceTimersByTime(60_000);
    });
    expect(list.queryByText('Rate limited') !== null).toBe(until === secondaryReset);

    await act(async () => {
      vi.setSystemTime(Date.parse(until) + 1);
      vi.advanceTimersByTime(60_000);
    });
    expect(list.queryByText('Rate limited')).toBeNull();
    expect(card.queryByText(/^Rate-limited until/)).toBeNull();
    expect(card.getByText('Heavy usage (100%)')).toBeTruthy();
    expect(list.getAllByText('100%').length).toBeGreaterThan(0);
    expect(card.queryByText('0%')).toBeNull();
    expect(projected.codex_quota.premium).toEqual(quota);

    const fresh = { ...projected, codex_quota: { premium: { ...quota, primary_used_percent: 12, secondary_used_percent: 35, ratelimited_until: undefined } } };
    view.rerender(<><div data-testid="list"><UpstreamSignals record={fresh} /></div><div data-testid="card"><CodexAccountCard record={fresh} /></div></>);
    expect(card.getByText('Active')).toBeTruthy();
    expect(list.getByText('12%')).toBeTruthy();
    expect(list.queryByText('100%')).toBeNull();
  });

  it('does not invent a timed restriction or zero usage when no exhausted reset is known', () => {
    const projected = { ...record, codex_quota: { premium: { observed_at: observed, primary_used_percent: 100 } } };
    renderInApp(<><UpstreamSignals record={projected} /><CodexAccountCard record={projected} /></>);
    expect(screen.queryByText('Rate limited')).toBeNull();
    expect(screen.queryByText(/^Rate-limited until/)).toBeNull();
    expect(screen.getByText('Heavy usage (100%)')).toBeTruthy();
    expect(screen.queryByText('0%')).toBeNull();
  });
});
