import { beforeEach, test, vi } from 'vitest';

import { assertEquals, assertThrows } from '@floway-dev/test-utils';

beforeEach(() => {
  vi.resetModules();
});

test('external resource fetcher must be initialized', async () => {
  const { getExternalResourceFetcher } = await import('../src/external-resource-fetcher.ts');

  assertThrows(
    () => getExternalResourceFetcher(),
    Error,
    'External resource fetcher not initialized',
  );
});

test('external resource fetcher exposes the initialized runtime implementation', async () => {
  const { getExternalResourceFetcher, initExternalResourceFetcher } = await import('../src/external-resource-fetcher.ts');
  const expected = async (_url: URL, _signal: AbortSignal): Promise<Response> => {
    throw new Error('identity-only test fetcher must not be called');
  };
  initExternalResourceFetcher(expected);

  assertEquals(getExternalResourceFetcher(), expected);
});
