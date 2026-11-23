import { expect, test, vi } from 'vitest';

import type { GatewayServices } from '../../../../src/data-plane/pipeline/services.ts';
import { type SearchUsageRecords, type SearchUsageSettlementFacts, writeSearchUsage } from '../../../../src/data-plane/tools/web-search/write-search-usage.ts';
import { compose, defineEnding, run } from '@floway-dev/pipeline';

type Output = SearchUsageSettlementFacts & { readonly 'response.webSearch.result': string };
const search = compose<object, Output, Pick<GatewayServices, 'searchUsageStore'>>('test.search', {
  stages: [writeSearchUsage],
  ending: defineEnding<object, Pick<Output, 'response.webSearch.result'> & SearchUsageRecords>({
    name: 'search',
    request: { needs: [] },
    return: { provides: ['response.webSearch.result', 'response.searchUsage.records'] },
    execute: async () => ({
      'response.webSearch.result': 'provider result',
      'response.searchUsage.records': [{ keyId: 'key', hour: '2026-01-01T00', provider: 'tavily', action: 'search', requests: 1 }],
    }),
  }),
});

test('search usage settlement preserves the response when storage fails', async () => {
  const failure = new Error('write failed');
  const record = vi.fn(async () => { throw failure; });
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const handle = run(search, {}, { services: { searchUsageStore: { record } }, finalizationTimeoutMs: 2000 });
    const result = await handle.result;
    expect(result['response.webSearch.result']).toBe('provider result');
    expect(result).not.toHaveProperty('response.searchUsage.records');
    expect(await result['response.searchUsage.settlement'].promise).toMatchObject({
      persisted: false, errors: [{ message: 'write failed' }],
    });
    expect(await handle.done).toEqual({ ok: true });
    expect(record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ action: 'search', requests: 1 }));
    expect(log).toHaveBeenCalledWith('Web search usage record error:', failure);
  } finally {
    log.mockRestore();
  }
});
