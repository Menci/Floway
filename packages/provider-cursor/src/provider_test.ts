import { describe, expect, test } from 'vitest';

import { createCursorProvider } from './provider.ts';
import type { UpstreamRecord } from '@floway-dev/provider';
import { noopUpstreamCallOptions, stubProviderModel } from '@floway-dev/test-utils';

const record: UpstreamRecord = {
  id: 'up',
  kind: 'cursor',
  name: 'Cursor',
  enabled: true,
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  config: { accounts: [{ email: 'a@b.com', userId: 'u1' }] },
  state: {
    accounts: [{
      userId: 'u1',
      refresh_token: 'rt',
      state: 'active',
      state_updated_at: '2026-01-01T00:00:00Z',
      accessToken: null,
    }],
  },
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
};

describe('createCursorProvider', () => {
  test('returns a cursor provider instance', async () => {
    const inst = await createCursorProvider(record);
    expect(inst.kind).toBe('cursor');
    expect(inst.upstream).toBe('up');
    expect(inst.instance.getPricingForModelKey('composer-2.5')?.input).toBe(0.5);
  });

  test('unsupported surfaces return 405', async () => {
    const inst = await createCursorProvider(record);
    const model = stubProviderModel({ id: 'gpt-4o' });
    const opts = noopUpstreamCallOptions();

    const messages = await inst.instance.callMessages(model, {} as never, undefined, opts);
    expect(messages.ok).toBe(false);
    if (!messages.ok) expect(messages.response.status).toBe(405);

    const embeddings = await inst.instance.callEmbeddings(model, {} as never, undefined, opts);
    expect(embeddings.response.status).toBe(405);

    const completions = await inst.instance.callCompletions(model, {} as never, undefined, opts);
    expect(completions.response.status).toBe(405);
  });
});
