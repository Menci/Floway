import { describe, expect, it } from 'vitest';

import type { ChatGPTQuotaSnapshotMap, ChatGPTRateLimitResetCredit, UpstreamRecord } from '../../../src/api/types';
import { accountStatus, chatgptRenewable, chatgptResetCreditIsUsable, findCredential, quotaEntries } from '../../../src/components/upstreams/chatgpt-account';

type ChatGPTRecord = Extract<UpstreamRecord, { kind: 'chatgpt' }>;

const ACCOUNT_ID = 'acct_0123456789abcdef';
const NOW = Date.parse('2026-07-28T12:00:00.000Z');
const PAST = '2026-07-28T11:00:00.000Z';
const FUTURE = '2026-07-28T13:00:00.000Z';
const activeCredential = { chatgptAccountId: ACCOUNT_ID, state: 'active' as const, state_updated_at: PAST };
const activeLookup = { kind: 'present' as const, credential: activeCredential };

const record = (state: ChatGPTRecord['state'], chatgptQuota?: ChatGPTQuotaSnapshotMap): ChatGPTRecord => ({
  id: 'up_1',
  kind: 'chatgpt',
  config: { accounts: [{ email: 'a@example.com', chatgptAccountId: ACCOUNT_ID, chatgptUserId: 'u1', planType: 'plus' }] },
  state,
  chatgpt_quota: chatgptQuota,
} as unknown as ChatGPTRecord);

describe('ChatGPT credential lookup', () => {
  it('matches the configured account rather than taking the first stored one', () => {
    const state = {
      accounts: [
        { chatgptAccountId: 'other', state: 'refresh_failed' as const, state_updated_at: PAST },
        { chatgptAccountId: ACCOUNT_ID, state: 'active' as const, state_updated_at: PAST },
      ],
    };
    const lookup = findCredential(record(state));
    expect(lookup.kind).toBe('present');
    if (lookup.kind === 'present') expect(lookup.credential.state).toBe('active');
  });
});

describe('ChatGPT reset cards', () => {
  const credit = (overrides: Partial<ChatGPTRateLimitResetCredit> = {}): ChatGPTRateLimitResetCredit => ({
    id: 'credit-1', reset_type: 'codex_rate_limits', status: 'available',
    granted_at: PAST, expires_at: FUTURE, title: null, description: null, ...overrides,
  });

  it('only enables known available, unexpired ChatGPT reset cards', () => {
    expect(chatgptResetCreditIsUsable(credit(), NOW)).toBe(true);
    expect(chatgptResetCreditIsUsable(credit({ status: 'redeemed' }), NOW)).toBe(false);
    expect(chatgptResetCreditIsUsable(credit({ reset_type: 'future_reset' }), NOW)).toBe(false);
    expect(chatgptResetCreditIsUsable(credit({ expires_at: PAST }), NOW)).toBe(false);
    expect(chatgptResetCreditIsUsable(credit({ expires_at: null }), NOW)).toBe(true);
  });
});

describe('ChatGPT account status', () => {
  it('reports the furthest live rate limit', () => {
    const entries = quotaEntries({
      daily: { observed_at: PAST, ratelimited_until: FUTURE },
      weekly: { observed_at: PAST, ratelimited_until: '2026-07-28T18:00:00.000Z' },
    }, NOW);
    expect(accountStatus(activeLookup, entries)).toEqual({ tone: 'danger', reason: 'rate-limited', until: '2026-07-28T18:00:00.000Z' });
  });

  it('puts a broken credential ahead of any quota reading', () => {
    const credential = { chatgptAccountId: ACCOUNT_ID, state: 'session_terminated' as const, state_message: 'revoked', state_updated_at: PAST };
    const entries = quotaEntries({ daily: { observed_at: PAST, ratelimited_until: FUTURE } }, NOW);
    expect(accountStatus({ kind: 'present', credential }, entries)).toEqual({ tone: 'danger', reason: 'session-terminated', detail: 'revoked' });
  });
});

describe('ChatGPT credential lookup without an account id', () => {
  it('joins config and state on a shared null', () => {
    const nullIdRecord = {
      id: 'up_1',
      kind: 'chatgpt',
      config: { accounts: [{ email: null, chatgptAccountId: null, chatgptUserId: null, planType: null }] },
      state: { accounts: [{ chatgptAccountId: null, state: 'active', state_updated_at: PAST, refresh_token_set: false }] },
    } as unknown as ChatGPTRecord;
    const lookup = findCredential(nullIdRecord);
    expect(lookup.kind).toBe('present');
    if (lookup.kind === 'present') expect(chatgptRenewable(lookup.credential)).toBe(false);
  });
});
