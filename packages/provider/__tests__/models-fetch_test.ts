import { expect, test } from 'vitest';

import { fetchUpstreamModels, ProviderModelsUnavailableError } from '../src/models-fetch.ts';

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
      controller.enqueue(bytes);
    },
    cancel() {
      cancelled = true;
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
