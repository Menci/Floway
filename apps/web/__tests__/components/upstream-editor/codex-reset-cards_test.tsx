import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CodexAccountCard } from '../../../src/components/upstream-editor/codex-account-card';
import { CodexResetCards } from '../../../src/components/upstream-editor/codex-reset-cards';
import type { CodexRecord } from '../../../src/components/upstreams/codex-account';
import { upstreamRecord } from '../../api/upstream-fixture';
import { stubLocalStorage } from '../../local-storage-stub';
import { renderInApp } from '../../render';

stubLocalStorage();

const card = {
  id: 'credit-1',
  reset_type: 'codex_rate_limits',
  status: 'available',
  granted_at: '2026-06-17T00:00:00Z',
  expires_at: null,
  title: 'Full reset',
  description: 'Ready to redeem',
};

const record = upstreamRecord('up_codex', {
  kind: 'codex',
  config: { accounts: [{ email: 'alice@example.com', chatgptAccountId: 'acc_test', chatgptUserId: 'usr_test', planType: 'plus' }] },
  state: { accounts: [{ chatgptAccountId: 'acc_test', state: 'active', state_updated_at: '2026-06-17T00:00:00Z' }] },
}) as CodexRecord;

let consumeBodies: Array<{ idempotency_key: string }>;
let consumeAttempts: number;
let failFirstConsume: boolean;

beforeEach(() => {
  consumeAttempts = 0;
  consumeBodies = [];
  failFirstConsume = true;
  vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000001');
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    if (path === '/api/upstreams/codex/reset-credits') {
      return Response.json({ reset_credits: { available_count: 1, credits: [card] } });
    }
    if (path === '/api/upstreams/codex/reset-credits/consume') {
      consumeAttempts += 1;
      consumeBodies.push(JSON.parse(String(init?.body)) as { idempotency_key: string });
      if (failFirstConsume && consumeAttempts === 1) return Response.json({ error: 'temporary failure' }, { status: 502 });
      return Response.json({
        outcome: { code: 'reset' },
        reset_credits: null,
        refresh_error: 'list refresh failed',
      });
    }
    throw new Error(`Unexpected request to ${path}`);
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Codex reset cards', () => {
  it('loads, confirms, and reuses one redemption key when a retry succeeds', async () => {
    const onQuotaReset = vi.fn();
    renderInApp(<CodexResetCards record={record} onQuotaReset={onQuotaReset} />);

    expect(await screen.findByText('Full reset')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Use' }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Use reset card' });

    fireEvent.click(confirm);
    expect(await within(dialog).findByText('Could not confirm the reset. Retry to check the same redemption safely.')).toBeTruthy();
    fireEvent.click(confirm);

    await waitFor(() => expect(onQuotaReset).toHaveBeenCalledOnce());
    expect(consumeBodies).toHaveLength(2);
    expect(consumeBodies.map(body => body.idempotency_key)).toEqual([
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000001',
    ]);
    expect(await screen.findByText('The Codex rate-limit windows were reset.')).toBeTruthy();
    expect(screen.queryByText('Full reset')).toBeNull();
    expect(screen.getByText(/The card was processed, but Floway could not refresh all details/)).toBeTruthy();
  });

  it('removes both the quota windows and account credit summary after a reset', async () => {
    failFirstConsume = false;
    const accountRecord: CodexRecord = {
      ...record,
      codex_quota: {
        codex: {
          observed_at: '2026-06-17T00:00:00Z',
          primary_used_percent: 100,
          credits_has_credits: true,
          credits_balance: 1,
        },
      },
    };
    const view = renderInApp(<CodexAccountCard record={accountRecord} />);

    expect(screen.getByText('credits: 1')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Use' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Use reset card' }));

    await waitFor(() => expect(screen.queryByText('credits: 1')).toBeNull());
    expect(screen.getByText('No quota snapshots yet - Codex calls populate them.')).toBeTruthy();

    view.rerender(<CodexAccountCard record={{ ...accountRecord, codex_quota: structuredClone(accountRecord.codex_quota) }} />);
    expect(screen.queryByText('credits: 1')).toBeNull();
    view.rerender(<CodexAccountCard record={{
      ...accountRecord,
      codex_quota: {
        codex: { observed_at: new Date(Date.now() + 1000).toISOString(), primary_used_percent: 5, credits_balance: 2 },
      },
    }} />);
    expect(screen.getByText('credits: 2')).toBeTruthy();
  });

  it('keeps the redemption key after an ambiguous failure and reopening confirmation', async () => {
    vi.mocked(crypto.randomUUID)
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000001')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000002');
    renderInApp(<CodexResetCards record={record} onQuotaReset={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Use' }));
    let dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Use reset card' }));
    expect(await within(dialog).findByText('Could not confirm the reset. Retry to check the same redemption safely.')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Use' }));
    dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Use reset card' }));
    await waitFor(() => expect(consumeBodies).toHaveLength(2));
    expect(consumeBodies[0].idempotency_key).toBe(consumeBodies[1].idempotency_key);
  });

  it('does not redeem when confirmation is cancelled', async () => {
    renderInApp(<CodexResetCards record={record} onQuotaReset={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Use' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(consumeBodies).toHaveLength(0);
  });

  it('shows a load failure without pretending there are no cards or echoing upstream input', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ error: 'sensitive stored input' }, { status: 502 }));
    renderInApp(<CodexResetCards record={record} onQuotaReset={vi.fn()} />);
    expect(await screen.findByText('Could not load reset cards. Try refreshing again.')).toBeTruthy();
    expect(screen.queryByText(/No reset cards are available/)).toBeNull();
    expect(screen.queryByText('sensitive stored input')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh reset cards' }));
    expect(await screen.findByText('Full reset')).toBeTruthy();
  });

  it('renders expired and unknown cards without offering redemption', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({
      reset_credits: {
        available_count: 0,
        credits: [
          { ...card, expires_at: '2000-01-01T00:00:00Z' },
          { ...card, id: 'future', reset_type: 'future_type', status: 'future_status' },
        ],
      },
    }));
    renderInApp(<CodexResetCards record={record} onQuotaReset={vi.fn()} />);
    expect(await screen.findByText('Expired')).toBeTruthy();
    expect(screen.getByText('future_status')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Use' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Expired' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'future_status' }).hasAttribute('disabled')).toBe(true);
    expect(consumeBodies).toHaveLength(0);
  });

  it('does not load reset cards for an unsaved account', () => {
    renderInApp(<CodexAccountCard record={{ ...record, id: '' }} />);
    expect(screen.queryByText('Reset cards')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps redeemed cards disabled until the upstream list removes them', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({
      reset_credits: { available_count: 0, credits: [{ ...card, status: 'redeemed' }] },
    }));
    renderInApp(<CodexResetCards record={record} onQuotaReset={vi.fn()} />);
    const redeemed = await screen.findByRole('button', { name: 'Redeemed' });
    expect(redeemed.hasAttribute('disabled')).toBe(true);
    fireEvent.click(redeemed);
    expect(consumeBodies).toHaveLength(0);

    vi.mocked(fetch).mockResolvedValueOnce(Response.json({
      reset_credits: { available_count: 0, credits: [] },
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh reset cards' }));
    expect(await screen.findByText('No reset cards are available for this ChatGPT subscription.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Redeemed' })).toBeNull();
  });
});
