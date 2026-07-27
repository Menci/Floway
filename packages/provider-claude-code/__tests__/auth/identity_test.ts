import { afterEach, describe, expect, test, vi } from 'vitest';

import { fetchClaudeCodeIdentity } from '../../src/auth/identity.ts';
import { jsonResponse } from '@floway-dev/test-utils';

afterEach(() => vi.restoreAllMocks());

const fullProfile = {
  account: { uuid: 'acc-uuid-1', email: 'user@example.com' },
  organization: { uuid: 'org-uuid-1', organization_type: 'claude_max', rate_limit_tier: 'default_claude_max_20x' },
};

describe('fetchClaudeCodeIdentity', () => {
  test('happy path returns flattened identity', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse(fullProfile));
    const identity = await fetchClaudeCodeIdentity('at_fresh');
    expect(identity).toEqual({
      email: 'user@example.com',
      accountUuid: 'acc-uuid-1',
      organizationUuid: 'org-uuid-1',
      subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x',
    });
  });

  test('403 permission_error → degraded identity with deterministic accountUuid', async () => {
    // Tokens minted without the `user:profile` scope hit 403 with a body of
    // `{ "error": { "type": "permission_error", "message": "..." } }`.
    // The fallback must succeed so the import path can still ingest the
    // credential — the data plane never reads email/org for routing.
    const permissionDenied = (): Response => jsonResponse({
      error: { type: 'permission_error', message: 'token lacks user:profile scope' },
    }, 403);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => permissionDenied());

    const identity = await fetchClaudeCodeIdentity('at_no_scope');

    expect(identity.email).toBeNull();
    expect(identity.organizationUuid).toBeNull();
    expect(identity.subscriptionType).toBeNull();
    // UUID-shaped (8-4-4-4-12 hex). The exact value is deterministic from
    // the token bytes; recompute on every call to assert stability.
    expect(identity.accountUuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    const second = await fetchClaudeCodeIdentity('at_no_scope');
    expect(second.accountUuid).toBe(identity.accountUuid);

    const different = await fetchClaudeCodeIdentity('at_other_token');
    expect(different.accountUuid).not.toBe(identity.accountUuid);
  });

  test('non-permission 403 still throws (unexpected upstream shape)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({
      error: { type: 'forbidden', message: 'something else' },
    }, 403));
    await expect(fetchClaudeCodeIdentity('at_x')).rejects.toThrow(/403/);
  });

  test('other 4xx still throws', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({ error: 'unauthorized' }, 401));
    await expect(fetchClaudeCodeIdentity('at_x')).rejects.toThrow(/401/);
  });

  test('5xx still throws', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({ error: 'boom' }, 503));
    await expect(fetchClaudeCodeIdentity('at_x')).rejects.toThrow(/503/);
  });
});
