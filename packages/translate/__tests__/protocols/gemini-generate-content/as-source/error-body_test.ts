import { test } from 'vitest';

import { restateGeminiGenerateContentError } from '../../../../src/protocols/gemini-generate-content/as-source/error-body.ts';
import { geminiGenerateContentErrorFromIR } from '../../../../src/protocols/gemini-generate-content/as-source/error.ts';
import { errorPayloadFromWire } from '../../../../src/shared/api-error.ts';
import { assertEquals } from '@floway-dev/test-utils';

const decoded = (result: { body: unknown } | undefined) => result!.body as {
  error: { code: number; status: string; message: string };
};

const upstreamOf = (status: number, body: unknown, headers: Record<string, string> = {}) => [
  status,
  new Headers({ 'x-upstream': 'a', ...headers }),
  new TextEncoder().encode(typeof body === 'string' ? body : JSON.stringify(body)),
] as const;

test('keeps the upstream status in both places GenerateContent states it', () => {
  const result = restateGeminiGenerateContentError(...upstreamOf(503, { error: { message: 'upstream overloaded' } }));
  assertEquals(result!.status, 503);
  assertEquals(decoded(result).error.code, 503);
  assertEquals(decoded(result).error.status, 'UNAVAILABLE');
  assertEquals(decoded(result).error.message, 'upstream overloaded');
});

test('keeps a status the inferred table would have flattened', () => {
  const result = restateGeminiGenerateContentError(...upstreamOf(402, { error: { message: 'payment required' } }));

  assertEquals(result!.status, 402);
  assertEquals(decoded(result).error.code, 402);
  assertEquals(decoded(result).error.status, 'UNKNOWN');
});

test('keeps the upstream headers a client reads', () => {
  const result = restateGeminiGenerateContentError(...upstreamOf(429, { error: { message: 'slow down' } }, { 'retry-after': '12', 'x-request-id': 'req_9' }));

  assertEquals(result!.headers.get('retry-after'), '12');
  assertEquals(result!.headers.get('x-request-id'), 'req_9');
  assertEquals(result!.headers.get('content-type'), 'application/json');
});

test('passes an unrecognized body through untouched', () => {
  assertEquals(restateGeminiGenerateContentError(...upstreamOf(500, 'internal blew up')), undefined);
  assertEquals(restateGeminiGenerateContentError(...upstreamOf(500, { detail: 'nope' })), undefined);
});

test('preserves the upstream failure fields beside the native RPC code', () => {
  const error = {
    message: 'bad field', type: 'invalid_request_error', code: 'invalid_value', param: 'temperature',
    provider_specific_fields: { request_id: 'req_1' }, retry_after: 10,
  };
  const result = restateGeminiGenerateContentError(...upstreamOf(400, { error }));
  const expected = {
    code: 400, status: 'INVALID_ARGUMENT', message: 'bad field',
    details: [{
      '@type': 'type.googleapis.com/google.protobuf.Struct',
      value: { type: 'invalid_request_error', code: 'invalid_value', param: 'temperature', request_id: 'req_1', retry_after: 10 },
    }],
  };
  assertEquals(decoded(result).error, expected);
  assertEquals(geminiGenerateContentErrorFromIR(errorPayloadFromWire(error), 400), expected);
});

test('context overflow determines both the HTTP status and body code', () => {
  const error = { message: 'too long', code: 'context_length_exceeded' };
  const result = restateGeminiGenerateContentError(...upstreamOf(502, { error }));
  assertEquals(result!.status, 400);
  assertEquals(decoded(result).error.code, 400);
  assertEquals(decoded(result).error.status, 'INVALID_ARGUMENT');
  assertEquals(decoded(result).error, geminiGenerateContentErrorFromIR(error));
});
