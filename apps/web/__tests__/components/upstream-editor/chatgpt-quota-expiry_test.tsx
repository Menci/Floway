import { act, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatGPTAccountCard } from '../../../src/components/upstream-editor/chatgpt-account-card';
import type { ChatGPTRecord } from '../../../src/components/upstreams/chatgpt-account';
import { UpstreamSignals } from '../../../src/components/upstreams/signals';
import { i18n } from '../../../src/i18n';
import { upstreamRecord } from '../../api/upstream-fixture';
import { stubLocalStorage } from '../../local-storage-stub';
import { renderInApp } from '../../render';
import { primeDefaultSession } from '../../test-session';

stubLocalStorage();

const observed = '2026-07-28T11:00:00.000Z';
const primaryReset = '2026-07-28T13:00:00.000Z';
const secondaryReset = '2026-08-01T12:00:00.000Z';
const record = upstreamRecord('', {
  kind: 'chatgpt',
  config: { accounts: [{ email: 'fixture@example.com', chatgptAccountId: 'fixture', chatgptUserId: 'fixture', planType: 'plus' }] },
  state: { accounts: [{ chatgptAccountId: 'fixture', state: 'active', state_updated_at: observed }] },
}) as ChatGPTRecord;

// Control-plane projections retain observed usage and date only known exhausted windows.
const cases = [
  { name: 'primary only', primary: 100, secondary: 35, until: primaryReset },
  { name: 'both known', primary: 100, secondary: 100, until: secondaryReset },
  { name: 'exhausted secondary without reset', primary: 100, secondary: 100, secondaryReset: undefined, until: primaryReset },
];

afterEach(() => vi.useRealTimers());

const rateLimited = i18n.t('dashboard.upstreams.signals.rateLimited');
const rateLimitedUntil = (node: Element | null) =>
  node?.textContent?.startsWith(i18n.t('dashboard.upstreamEditor.chatgpt.rateLimitedUntil', { time: '' })) ?? false;
const statusLabel = (key: 'active' | 'heavy', percent?: number) => i18n.t(`dashboard.upstreamEditor.chatgpt.status.${key}`, { percent });
const remaining = (percent: number) => i18n.t('dashboard.upstreamEditor.quotaRemainingPercent', { percent });

beforeEach(() => { primeDefaultSession(); });

describe('ChatGPT projected quota on list and card', () => {
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
    const projected = { ...record, chatgpt_quota: { premium: quota } };
    const view = renderInApp(<><div data-testid="list"><UpstreamSignals record={projected} /></div><div data-testid="card"><ChatGPTAccountCard record={projected} /></div></>);
    const list = within(screen.getByTestId('list'));
    const card = within(screen.getByTestId('card'));
    expect(list.getByText(rateLimited)).toBeTruthy();
    expect(card.getAllByText((_, node) => rateLimitedUntil(node) && node!.children.length === 0)).toHaveLength(2);

    // Passing the short reset must not clear a genuine later exhausted window.
    await act(async () => {
      vi.setSystemTime(Date.parse(primaryReset) + 1);
      vi.advanceTimersByTime(60_000);
    });
    expect(list.queryByText(rateLimited) !== null).toBe(until === secondaryReset);

    await act(async () => {
      vi.setSystemTime(Date.parse(until) + 1);
      vi.advanceTimersByTime(60_000);
    });
    expect(list.queryByText(rateLimited)).toBeNull();
    expect(card.queryAllByText((_, node) => rateLimitedUntil(node) && node!.children.length === 0)).toHaveLength(0);
    expect(card.getByText(statusLabel('heavy', 100))).toBeTruthy();
    expect(list.getAllByText('0%').length).toBeGreaterThan(0);
    expect(card.getAllByText(remaining(0)).length).toBeGreaterThan(0);
    expect(projected.chatgpt_quota.premium).toEqual(quota);

    const fresh = { ...projected, chatgpt_quota: { premium: { ...quota, primary_used_percent: 12, secondary_used_percent: 35, ratelimited_until: undefined } } };
    view.rerender(<><div data-testid="list"><UpstreamSignals record={fresh} /></div><div data-testid="card"><ChatGPTAccountCard record={fresh} /></div></>);
    expect(card.getByText(statusLabel('active'))).toBeTruthy();
    expect(list.getByText('88%')).toBeTruthy();
    expect(card.getByText(remaining(88))).toBeTruthy();
    expect(list.queryByText('0%')).toBeNull();
  });
});
