import { test } from 'vitest';

import { restateGeminiGenerateContentError } from '../../../../src/protocols/gemini-generate-content/as-source/error-body.ts';
import { assertEquals } from '@floway-dev/test-utils';

const decoded = (result: { body: unknown } | undefined) => result!.body as {
  error: { code: number; status: string; message: string };
};

const upstreamOf = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
  status,
  headers: new Headers({ 'x-upstream': 'a', ...headers }),
  body: new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body)),
});

test('keeps the upstream status in both places GenerateContent states it', () => {
  const result = restateGeminiGenerateContentError(upstreamOf(503, { error: { message: 'upstream overloaded' } }));

  // The protocol repeats the HTTP status inside the error object, so the two
  // must agree. Re-deriving the code from the message would report a different
  // failure than the one that happened.
  assertEquals(result!.status, 503);
  assertEquals(decoded(result).error.code, 503);
  assertEquals(decoded(result).error.status, 'UNAVAILABLE');
  assertEquals(decoded(result).error.message, 'upstream overloaded');
});

test('keeps a status the inferred table would have flattened', () => {
  const result = restateGeminiGenerateContentError(upstreamOf(402, { error: { message: 'payment required' } }));

  assertEquals(result!.status, 402);
  assertEquals(decoded(result).error.code, 402);
  assertEquals(decoded(result).error.status, 'UNKNOWN');
});

test('keeps the upstream headers a client reads', () => {
  const result = restateGeminiGenerateContentError(upstreamOf(429, { error: { message: 'slow down' } }, { 'retry-after': '12', 'x-request-id': 'req_9' }));

  assertEquals(result!.headers.get('retry-after'), '12');
  assertEquals(result!.headers.get('x-request-id'), 'req_9');
  assertEquals(result!.headers.get('content-type'), 'application/json');
});

test('passes an unrecognized body through untouched', () => {
  assertEquals(restateGeminiGenerateContentError(upstreamOf(500, 'internal blew up')), undefined);
  assertEquals(restateGeminiGenerateContentError(upstreamOf(500, { detail: 'nope' })), undefined);
});
