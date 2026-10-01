import { expect, test } from 'vitest';

import { metadata } from './fixtures.ts';
import { dumpCodec } from '../src/index.ts';

test('broker frames round-trip the shared Floway metadata contract', () => {
  const meta = metadata({
    upstream: { id: 'upstream', name: 'Configured upstream', kind: 'custom', hue: 42 },
    targetApi: 'openaiResponses',
    ttftMs: 12,
    inputTokens: 0,
    error: { kind: 'failed', reason: 'source interrupted' },
  });
  expect(dumpCodec.decode(dumpCodec.encode(meta))).toEqual(meta);
  expect(JSON.parse(dumpCodec.encode(meta))).toEqual({ event: 'appended', data: meta });
});

test('broker decoding rejects valid JSON with malformed metadata', () => {
  expect(() => dumpCodec.decode(JSON.stringify({ event: 'appended', data: { ...metadata(), status: '200' } })))
    .toThrow(/Invalid dump broker frame.*status/su);
});

test('broker decoding preserves the JSON parse failure in its error chain', () => {
  let caught: unknown;
  try { dumpCodec.decode('{invalid'); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).cause).toBeInstanceOf(SyntaxError);
});
