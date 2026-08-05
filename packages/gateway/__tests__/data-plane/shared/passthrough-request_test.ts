import { test } from 'vitest';

import { prepareJsonModelRequest } from '../../../src/data-plane/shared/passthrough-request.ts';
import { assertEquals } from '@floway-dev/test-utils';

const encodeJson = (value: unknown): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(value));

test('prepareJsonModelRequest rejects invalid UTF-8 before JSON parsing', () => {
  assertEquals(prepareJsonModelRequest(Uint8Array.of(0xff), 'Embeddings'), {
    type: 'invalid',
    message: 'Embeddings request body must be valid JSON.',
  });
});

test.each([
  ['null', null],
  ['scalar', 1],
  ['array', [{ model: 'text-embedding-3-small' }]],
] as const)('prepareJsonModelRequest rejects a top-level %s', (_name, body) => {
  assertEquals(prepareJsonModelRequest(encodeJson(body), 'Embeddings'), {
    type: 'invalid',
    message: 'Embeddings request body must be an object.',
  });
});

test.each([
  ['missing', {}],
  ['empty', { model: '' }],
  ['non-string', { model: 1 }],
] as const)('prepareJsonModelRequest rejects a %s model', (_name, body) => {
  assertEquals(prepareJsonModelRequest(encodeJson(body), 'Embeddings'), {
    type: 'invalid',
    message: 'Embeddings request body must include a model string.',
  });
});

test('prepareJsonModelRequest returns the parsed object and model', () => {
  assertEquals(prepareJsonModelRequest(encodeJson({ model: 'text-embedding-3-small', input: 'hello' }), 'Embeddings'), {
    type: 'ok',
    body: { model: 'text-embedding-3-small', input: 'hello' },
    model: 'text-embedding-3-small',
  });
});
