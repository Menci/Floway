import { describe, expect, test } from 'vitest';

import { assertClaudeCodeUpstreamRecord, claudeCodeUpstreamFact } from '../src/config.ts';
import type { UpstreamRecord } from '@floway-dev/provider';

const goodAccount = {
  email: 'a@b.com',
  accountUuid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  organizationUuid: null,
  subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x',
};

const wrap = (config: unknown): UpstreamRecord => ({
  id: 'up', kind: 'claude-code', name: 'n', enabled: true, usageRefreshIntervalMinutes: 0, sortOrder: 0,
  createdAt: '', updatedAt: '', config: config as UpstreamRecord['config'], state: null,
  flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [], modelPrefix: null, modelsCache: null, hue: 210,
});

describe('assertClaudeCodeUpstreamRecord (config validation)', () => {
  test.each([
    ['subscriptionType outside the known plans', { accounts: [{ ...goodAccount, subscriptionType: 'free' }] }],
    ['multiple accounts', { accounts: [goodAccount, { ...goodAccount, accountUuid: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' }] }],
  ])('rejects %s', (_label, value) => {
    expect(() => assertClaudeCodeUpstreamRecord(wrap(value))).toThrow();
  });
});

test('projects only Claude Code configuration into the upstream fact', () => {
  const config = { accounts: [goodAccount] };
  const record = {
    ...wrap(config),
    state: { accounts: [{ accessToken: 'access-token', refreshToken: 'refresh-token' }] },
  };
  const fact = claudeCodeUpstreamFact(record);
  expect(fact).toEqual({ id: record.id, kind: 'claude-code', name: record.name, config });
  expect(fact.config).toBe(config);
});

test('rejects credentials placed in the Claude Code account config', () => {
  expect(() => claudeCodeUpstreamFact(wrap({
    accounts: [{ ...goodAccount, accessToken: 'access-token' }],
  }))).toThrow("unexpected key 'accessToken'");
});
