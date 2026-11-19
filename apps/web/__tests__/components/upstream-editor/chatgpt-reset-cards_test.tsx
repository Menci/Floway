import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatGPTResetCards } from '../../../src/components/upstream-editor/chatgpt-reset-cards';
import type { ChatGPTRecord } from '../../../src/components/upstreams/chatgpt-account';
import { i18n } from '../../../src/i18n';
import { upstreamRecord } from '../../api/upstream-fixture';
import { stubLocalStorage } from '../../local-storage-stub';
import { renderInApp } from '../../render';
import { primeDefaultSession } from '../../test-session';

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

const record = upstreamRecord('up_chatgpt', {
  kind: 'chatgpt',
  config: { accounts: [{ email: 'alice@example.com', chatgptAccountId: 'acc_test', chatgptUserId: 'usr_test', planType: 'plus' }] },
  state: { accounts: [{ chatgptAccountId: 'acc_test', state: 'active', state_updated_at: '2026-06-17T00:00:00Z' }] },
}) as ChatGPTRecord;

let consumeBodies: Array<{ idempotency_key: string }>;
let consumeAttempts: number;
let failFirstConsume: boolean;

beforeEach(() => { primeDefaultSession(); });

beforeEach(() => {
  consumeAttempts = 0;
  consumeBodies = [];
  failFirstConsume = true;
  vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000001');
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    if (path === '/api/upstreams/chatgpt/reset-credits') {
      return Response.json({ reset_credits: { available_count: 1, credits: [card] } });
    }
    if (path === '/api/upstreams/chatgpt/reset-credits/consume') {
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

describe('ChatGPT reset cards', () => {
  it('loads, confirms, and reuses one redemption key when a retry succeeds', async () => {
    const onQuotaReset = vi.fn();
    renderInApp(<ChatGPTResetCards record={record} onQuotaReset={onQuotaReset} />);

    expect(await screen.findByText('Full reset')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Use' }));
    const dialog = await screen.findByRole('dialog');
    const confirm = await within(dialog).findByRole('button', { name: 'Use reset card' });

    fireEvent.click(confirm);
    expect(await within(dialog).findByText(i18n.t('dashboard.upstreamEditor.chatgpt.resetCards.redeemError'))).toBeTruthy();
    fireEvent.click(confirm);

    await waitFor(() => expect(onQuotaReset).toHaveBeenCalledOnce());
    expect(consumeBodies).toHaveLength(2);
    expect(consumeBodies.map(body => body.idempotency_key)).toEqual([
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000001',
    ]);
    expect(await screen.findByText(i18n.t('dashboard.upstreamEditor.chatgpt.resetCards.result.reset'))).toBeTruthy();
    expect(screen.queryByText('Full reset')).toBeNull();
    expect(screen.getByText(i18n.t('dashboard.upstreamEditor.chatgpt.resetCards.refreshWarning'))).toBeTruthy();
  });

  it('keeps the redemption key after an ambiguous failure and reopening confirmation', async () => {
    vi.mocked(crypto.randomUUID)
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000001')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000002');
    renderInApp(<ChatGPTResetCards record={record} onQuotaReset={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Use' }));
    let dialog = await screen.findByRole('dialog');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Use reset card' }));
    expect(await within(dialog).findByText(i18n.t('dashboard.upstreamEditor.chatgpt.resetCards.redeemError'))).toBeTruthy();
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(await screen.findByRole('button', { name: 'Use' }));
    dialog = await screen.findByRole('dialog');
    // The focus trap can mark a freshly reopened surface aria-hidden for a
    // while after the previous one closed; the redemption key is under test
    // here, not the surface's accessibility state.
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Use reset card', hidden: true }));
    await waitFor(() => expect(consumeBodies).toHaveLength(2));
    expect(consumeBodies[0].idempotency_key).toBe(consumeBodies[1].idempotency_key);
  });
});
