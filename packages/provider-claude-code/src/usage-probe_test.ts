import { describe, expect, test, vi } from 'vitest';

import { fetchClaudeCodeUsageProbe } from './usage-probe.ts';
import type { Fetcher } from '@floway-dev/provider';
import { jsonResponse } from '@floway-dev/test-utils';

describe('fetchClaudeCodeUsageProbe', () => {
  test('returns the parsed JSON body with a fetched_at timestamp', async () => {
    const body = {
      five_hour: { utilization: 0.42, resets_at: '2026-06-19T20:00:00Z' },
      seven_day: { utilization: 0.10, resets_at: '2026-06-25T18:00:00Z' },
      seven_day_sonnet: { utilization: 0.05, resets_at: '2026-06-25T18:00:00Z' },
    };
    const fetcher: Fetcher = vi.fn(async () => jsonResponse(body));

    const result = await fetchClaudeCodeUsageProbe('at_test', fetcher);

    expect(result.body).toEqual(body);
    expect(typeof result.fetched_at).toBe('string');
    expect(Date.parse(result.fetched_at)).not.toBeNaN();
  });

  test('passes the OAuth bearer plus the anthropic-beta header the upstream requires', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetcher: Fetcher = vi.fn(async (url, init) => {
      calls.push({ url: String(url), init: init as RequestInit | undefined });
      return jsonResponse({ five_hour: {} });
    });
    await fetchClaudeCodeUsageProbe('at_test', fetcher);

    expect(calls[0].url).toBe('https://api.anthropic.com/api/oauth/usage');
    const headers = (calls[0].init?.headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBe('Bearer at_test');
    // Without oauth-2025-04-20 the upstream returns 401 even for a valid
    // bearer (verified against sub2api's pinned set); this assertion pins
    // the requirement.
    expect(headers['anthropic-beta']).toBe('oauth-2025-04-20');
    expect(headers['anthropic-version']).toBe('2023-06-01');
  });

  test('throws on a non-2xx upstream response', async () => {
    const fetcher: Fetcher = vi.fn(async () => new Response('forbidden', { status: 401, headers: { 'content-type': 'text/plain' } }));
    await expect(fetchClaudeCodeUsageProbe('at_test', fetcher)).rejects.toThrow(/401/);
  });

  test('throws on a non-JSON 2xx response', async () => {
    const fetcher: Fetcher = vi.fn(async () => new Response('definitely not json', { status: 200, headers: { 'content-type': 'text/plain' } }));
    await expect(fetchClaudeCodeUsageProbe('at_test', fetcher)).rejects.toThrow(/non-JSON/);
  });
});
