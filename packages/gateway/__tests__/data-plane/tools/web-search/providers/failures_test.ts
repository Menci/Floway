import { expect, test, vi } from 'vitest';

import { createJinaWebSearchProvider } from '../../../../../src/data-plane/tools/web-search/providers/jina.ts';
import { createMicrosoftWebIqWebSearchProvider } from '../../../../../src/data-plane/tools/web-search/providers/microsoft-web-iq.ts';
import { createTavilyWebSearchProvider } from '../../../../../src/data-plane/tools/web-search/providers/tavily.ts';

test.each([
  ['Jina', createJinaWebSearchProvider],
  ['Microsoft Web IQ', createMicrosoftWebIqWebSearchProvider],
  ['Tavily', createTavilyWebSearchProvider],
] as const)('%s keeps expected transport and JSON failures in-band', async (_name, create) => {
  const unavailable = { type: 'error', errorCode: 'unavailable' };
  const disconnected = create('key', { fetch: () => Promise.reject(new TypeError('fetch failed')) });
  const cutOff = create('key', {
    fetch: () => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.error(new TypeError('terminated')); },
    }))),
  });
  const invalidJson = create('key', { fetch: () => Promise.resolve(new Response('{')) });
  for (const provider of [disconnected, cutOff, invalidJson]) {
    await expect(provider.search({ query: 'example' })).resolves.toMatchObject(unavailable);
    await expect(provider.fetchPage({ urls: ['https://example.com/'] })).resolves.toMatchObject(unavailable);
  }
});

test.each([
  ['Jina', createJinaWebSearchProvider],
  ['Microsoft Web IQ', createMicrosoftWebIqWebSearchProvider],
  ['Tavily', createTavilyWebSearchProvider],
] as const)('%s propagates a body reader defect even after the caller aborts', async (_name, create) => {
  const controller = new AbortController();
  const defect = new TypeError('unexpected reader failure');
  const provider = create('key', {
    fetch: () => {
      controller.abort();
      return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
        start(stream) { stream.error(defect); },
      })));
    },
  });
  await expect(provider.search({ query: 'example', signal: controller.signal })).rejects.toBe(defect);
  await expect(provider.fetchPage({ urls: ['https://example.com/'], signal: controller.signal })).rejects.toBe(defect);
});

test('provider diagnostics keep plain HTTP error text and propagate a parser defect', async () => {
  const message = 'upstream refused the query';
  const provider = createTavilyWebSearchProvider('key', {
    fetch: () => Promise.resolve(new Response(message, { status: 400 })),
  });
  await expect(provider.search({ query: 'example' })).resolves.toEqual({
    type: 'error', errorCode: 'invalid_tool_input', message,
  });

  const defect = new TypeError('unexpected diagnostic parser failure');
  const jsonParse = JSON.parse;
  const parse = vi.spyOn(JSON, 'parse').mockImplementation((text, reviver) => {
    if (text === message) throw defect;
    return jsonParse(text, reviver);
  });
  try {
    await expect(provider.search({ query: 'example' })).rejects.toBe(defect);
    expect(parse).toHaveBeenCalledWith(message);
  } finally {
    parse.mockRestore();
  }
});
