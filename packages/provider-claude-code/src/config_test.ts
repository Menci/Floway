import { describe, expect, test } from 'vitest';

import { assertClaudeCodeUpstreamRecord } from './config.ts';
import type { UpstreamRecord } from '@floway-dev/provider';

const goodAccount = {
  email: 'a@b.com',
  accountUuid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  organizationUuid: null,
  subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x',
};
const good = { accounts: [goodAccount] };

const wrap = (config: unknown): UpstreamRecord => ({
  id: 'up', kind: 'claude-code', name: 'n', enabled: true, sortOrder: 0,
  createdAt: '', updatedAt: '', config: config as UpstreamRecord['config'], state: null,
  flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [], modelPrefix: null,
});

describe('assertClaudeCodeUpstreamRecord (config validation)', () => {
  test('accepts a complete config', () => {
    expect(() => assertClaudeCodeUpstreamRecord(wrap(good))).not.toThrow();
  });
  test('accepts a config with a populated organizationUuid', () => {
    expect(() => assertClaudeCodeUpstreamRecord(wrap({
      accounts: [{ ...goodAccount, organizationUuid: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' }],
    }))).not.toThrow();
  });
  test('accepts a personal-account config with null subscriptionType', () => {
    expect(() => assertClaudeCodeUpstreamRecord(wrap({
      accounts: [{ ...goodAccount, subscriptionType: null }],
    }))).not.toThrow();
  });
  test('accepts an account with null email (degraded-identity import path)', () => {
    expect(() => assertClaudeCodeUpstreamRecord(wrap({
      accounts: [{ ...goodAccount, email: null }],
    }))).not.toThrow();
  });
  test.each([
    ['email empty', { accounts: [{ ...goodAccount, email: '' }] }],
    ['email type', { accounts: [{ ...goodAccount, email: 123 }] }],
    ['accountUuid missing', { accounts: [{ ...goodAccount, accountUuid: undefined }] }],
    ['accountUuid empty', { accounts: [{ ...goodAccount, accountUuid: '' }] }],
    ['organizationUuid empty string', { accounts: [{ ...goodAccount, organizationUuid: '' }] }],
    ['organizationUuid wrong type', { accounts: [{ ...goodAccount, organizationUuid: 123 }] }],
    ['subscriptionType missing', { accounts: [{ ...goodAccount, subscriptionType: undefined }] }],
    ['subscriptionType empty', { accounts: [{ ...goodAccount, subscriptionType: '' }] }],
    ['subscriptionType wrong type', { accounts: [{ ...goodAccount, subscriptionType: 123 }] }],
    ['extra unknown field on account', { accounts: [{ ...goodAccount, extra: 1 }] }],
    ['extra unknown field at top level', { ...good, extra: 1 }],
    ['accounts not an array', { accounts: goodAccount }],
    ['empty accounts array', { accounts: [] }],
    ['multiple accounts', { accounts: [goodAccount, { ...goodAccount, accountUuid: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' }] }],
  ])('rejects %s', (_label, value) => {
    expect(() => assertClaudeCodeUpstreamRecord(wrap(value))).toThrow();
  });
  test('rejects null / non-object configs', () => {
    expect(() => assertClaudeCodeUpstreamRecord(wrap(null))).toThrow();
    expect(() => assertClaudeCodeUpstreamRecord(wrap('a'))).toThrow();
    expect(() => assertClaudeCodeUpstreamRecord(wrap([]))).toThrow();
  });
});

describe('assertClaudeCodeUpstreamRecord (record-level checks)', () => {
  test('rejects non-claude-code record', () => {
    const record: UpstreamRecord = {
      id: 'up', kind: 'copilot', name: 'n', enabled: true, sortOrder: 0,
      createdAt: '', updatedAt: '', config: {}, state: null,
      flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [], modelPrefix: null,
    };
    expect(() => assertClaudeCodeUpstreamRecord(record)).toThrow();
  });
});
