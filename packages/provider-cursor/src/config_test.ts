import { describe, expect, test } from 'vitest';

import { assertCursorUpstreamRecord } from './config.ts';
import type { UpstreamRecord } from '@floway-dev/provider';

const goodAccount = { email: 'a@b.com', userId: 'u1' };
const good = { accounts: [goodAccount] };

const wrap = (config: unknown): UpstreamRecord => ({
  id: 'up',
  kind: 'cursor',
  name: 'n',
  enabled: true,
  sortOrder: 0,
  createdAt: '',
  updatedAt: '',
  config: config as UpstreamRecord['config'],
  state: null,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
});

describe('assertCursorUpstreamRecord (config validation)', () => {
  test('accepts a complete config', () => {
    expect(() => assertCursorUpstreamRecord(wrap(good))).not.toThrow();
  });

  test('rejects the wrong kind', () => {
    expect(() => assertCursorUpstreamRecord({ ...wrap(good), kind: 'codex' })).toThrow("Expected kind 'cursor'");
  });

  test.each([
    ['email empty', { accounts: [{ ...goodAccount, email: '' }] }],
    ['email type', { accounts: [{ ...goodAccount, email: 123 }] }],
    ['userId missing', { accounts: [{ ...goodAccount, userId: undefined }] }],
    ['extra field on account', { accounts: [{ ...goodAccount, extra: 1 }] }],
    ['extra top-level field', { ...good, extra: 1 }],
    ['accounts not an array', { accounts: goodAccount }],
    ['empty accounts array', { accounts: [] }],
    ['two accounts (v1 invariant)', { accounts: [goodAccount, { ...goodAccount, userId: 'u2' }] }],
  ])('rejects %s', (_label, value) => {
    expect(() => assertCursorUpstreamRecord(wrap(value))).toThrow();
  });

  test('accepts an explicit privacyMode boolean', () => {
    expect(() => assertCursorUpstreamRecord(wrap({ ...good, privacyMode: true }))).not.toThrow();
    expect(() => assertCursorUpstreamRecord(wrap({ ...good, privacyMode: false }))).not.toThrow();
  });

  test('rejects a non-boolean privacyMode', () => {
    expect(() => assertCursorUpstreamRecord(wrap({ ...good, privacyMode: 'true' }))).toThrow(/privacyMode must be a boolean/);
  });
});
