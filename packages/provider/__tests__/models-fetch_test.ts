import { expect, test } from 'vitest';

import { fetchUpstreamModels, httpResponseToResponse, ProviderModelsUnavailableError } from '../src/models-fetch.ts';

test('fetchUpstreamModels accepts the byte boundary and cancels an oversized success body', async () => {
  const json = '{"ok":true}';
  const bytes = new TextEncoder().encode(json);
  await expect(fetchUpstreamModels(
    () => Promise.resolve(new Response(bytes)),
    value => value as { ok: boolean },
    { maxResponseBytes: bytes.byteLength },
  )).resolves.toEqual({ ok: true });

  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, 6));
      controller.enqueue(bytes.slice(6));
    },
    cancel() {
      cancelled = true;
      return new Promise<void>(() => {});
    },
  });
  const result = fetchUpstreamModels(
    () => Promise.resolve(new Response(body)),
    value => value,
    { maxResponseBytes: bytes.byteLength - 1 },
  );
  await expect(result).rejects.toMatchObject({
    name: 'ProviderModelsUnavailableError',
    cause: expect.objectContaining({ message: `Provider model listing exceeded ${bytes.byteLength - 1} response bytes` }),
  } satisfies Partial<ProviderModelsUnavailableError>);
  expect(cancelled).toBe(true);
});

test('fetchUpstreamModels bounds non-2xx bodies while preserving status and headers', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('rate-'));
      controller.enqueue(new TextEncoder().encode('limited'));
    },
    cancel() {
      cancelled = true;
      return new Promise<void>(() => {});
    },
  });
  const result = fetchUpstreamModels(
    () => Promise.resolve(new Response(body, {
      status: 429,
      headers: {
        'content-digest': 'sha-256=:invalid-after-truncation:',
        'content-encoding': 'gzip',
        'content-length': '999',
        'retry-after': '5',
      },
    })),
    value => value,
    { maxErrorResponseBytes: 8 },
  );
  await expect(result).rejects.toMatchObject({
    name: 'ProviderModelsUnavailableError',
    httpResponse: {
      status: 429,
      body: 'rate-lim...[truncated]',
    },
  });
  const error = await result.catch(cause => cause as ProviderModelsUnavailableError);
  expect(error.httpResponse?.headers.get('retry-after')).toBe('5');
  expect(error.httpResponse?.headers.get('content-length')).toBeNull();
  expect(error.httpResponse?.headers.get('content-encoding')).toBeNull();
  expect(error.httpResponse?.headers.get('content-digest')).toBeNull();
  const reconstructed = httpResponseToResponse(error.httpResponse);
  expect(reconstructed?.status).toBe(429);
  expect(await reconstructed?.text()).toBe('rate-lim...[truncated]');
  expect(cancelled).toBe(true);
});
