import { expect, test } from 'vitest';

import { saveUpstreamForTest } from '../../../repo/upstreams.ts';
import { MOCKED_FETCH_EGRESS, requestApp, setupAppTest } from '../../../test-utils/app.ts';
import type { UpstreamRecord } from '@floway-dev/provider';
import { withMockedFetch } from '@floway-dev/test-utils';

for (const speed of [undefined, 'standard', 'fast']) test(`Kimi Code count_tokens requires fast mode for a fast-only family (${speed})`, async () => {
  const { adminSession, apiKey, repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  const record: UpstreamRecord = {
    id: 'up_kimi_count', kind: 'kimi-code', config: { region: 'china', apiKey: 'sk-kimi-fake-count-key' },
    state: null, name: 'Kimi Code', enabled: true, usageRefreshIntervalMinutes: 0, sortOrder: 0,
    createdAt: '', updatedAt: '', flagOverrides: {}, disabledPublicModelIds: [],
    proxyFallbackList: MOCKED_FETCH_EGRESS, modelPrefix: null, modelsCache: null, hue: 210,
  };
  await saveUpstreamForTest(repo.upstreams, record);
  let measurements = 0;
  await withMockedFetch(async request => {
    if (request.url.endsWith('/models')) return Response.json({
      data: [{ id: 'kimi-for-coding-highspeed', display_name: 'K2.7 Code Highspeed', context_length: 262_144 }],
    });
    expect(request.url).toBe('https://api.kimi.com/coding/v1/messages/count_tokens');
    expect(await request.json()).toMatchObject({ model: 'kimi-for-coding-highspeed' });
    measurements++;
    return Response.json({ input_tokens: 7 });
  }, async () => {
    const catalog = await requestApp(`/api/upstreams/${record.id}/list-models`, { method: 'POST', headers: { 'x-floway-session': adminSession } });
    expect(catalog.status).toBe(200);
    const response = await requestApp('/v1/messages/count_tokens', {
      method: 'POST', headers: { 'x-api-key': apiKey.key, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'kimi-k2.7-code', messages: [{ role: 'user', content: 'hello' }], speed }),
    });
    expect(response.status).toBe(speed === 'fast' ? 200 : 400);
    if (speed === 'fast') {
      expect(await response.json()).toEqual({ input_tokens: 7 });
    } else {
      expect(await response.json()).toMatchObject({ type: 'error', error: { type: 'invalid_request_error', message: '\'kimi-k2.7-code\' is only available with fast mode selected; set `speed: "fast"`.' } });
    }
    expect(measurements).toBe(speed === 'fast' ? 1 : 0);
  });
});
