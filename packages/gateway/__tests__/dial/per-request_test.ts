import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createPerRequestFetcher } from '../../src/dial/per-request.ts';
import { initRepo } from '../../src/repo/index.ts';
import { InMemoryRepo } from '../repo/memory.ts';
import { saveUpstreamForTest } from '../repo/upstreams.ts';
import { initSocketDial, resetSocketDialForTesting, type SocketDial } from '@floway-dev/platform';
import type { ProxyFallbackEntry } from '@floway-dev/provider';

const stubSocketDial: SocketDial = {
  connect: async () => {
    throw new Error('stub: per-request_test should not reach a real dial');
  },
  startTls: async () => {
    throw new Error('stub: per-request_test should not reach a real dial');
  },
};

const COPILOT_CONFIG = {
  githubHost: 'github.com',
  githubToken: 'tok',
  user: { login: 'u', avatar_url: '', name: null, id: 1 },
};

const upstream = (id: string, proxyFallbackList: ProxyFallbackEntry[]) => ({
  id,
  kind: 'copilot' as const,
  name: id,
  enabled: true,
  usageRefreshIntervalMinutes: 0,
  sortOrder: 0,
  createdAt: '2026-06-01T00:00:00Z',
  updatedAt: '2026-06-01T00:00:00Z',
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList,
  modelPrefix: null,
  hue: 210,
  config: COPILOT_CONFIG,
  state: null,
});

describe('createPerRequestFetcher', () => {
  beforeEach(() => {
    initSocketDial(stubSocketDial);
  });
  afterEach(() => {
    resetSocketDialForTesting();
  });

  it('isolates a malformed proxy URL to upstreams that reference it', async () => {
    const repo = new InMemoryRepo();
    initRepo(repo);
    // u_bad references the malformed row; u_ok shares the request but does
    // not. The whole-request build must still succeed; only u_bad's fetcher
    // surfaces the parse error, and only when actually called.
    const upBad = upstream('u_bad', [{ id: 'p_bad' }]);
    const upOk = upstream('u_ok', []);
    await saveUpstreamForTest(repo.upstreams, upBad);
    await saveUpstreamForTest(repo.upstreams, upOk);
    await repo.proxies.insert({ id: 'p_bad', name: 'Bad', url: 'gibberish-no-scheme', dialTimeoutSeconds: null });

    const fetcherFor = await createPerRequestFetcher('TEST', [upBad, upOk]);
    const badFetcher = fetcherFor('u_bad');
    await expect(badFetcher('https://example.com', { method: 'GET' }))
      .rejects.toThrow();
    // u_ok's empty fallback list never references p_bad, so resolving its
    // fetcher must not throw at build time the way the malformed row did
    // when first parsed.
    fetcherFor('u_ok');
  });

});
