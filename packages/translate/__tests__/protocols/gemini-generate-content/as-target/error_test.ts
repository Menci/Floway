import { expect, test } from 'vitest';

import {
  geminiGenerateContentErrorFromEvent,
  readGeminiGenerateContentErrorBody,
} from '../../../../src/protocols/gemini-generate-content/as-target/error.ts';

const httpError = (value: unknown, status = 400) => ({
  status,
  headers: new Headers({ 'content-type': 'application/json' }),
  body: new TextEncoder().encode(JSON.stringify(value)),
});

test('unwraps single-element Google streamGenerateContent error arrays and preserves wire code and status keys', () => {
  const googleError = {
    error: { code: 400, message: 'bad field', status: 'INVALID_ARGUMENT', details: [{ reason: 'INVALID' }] },
  };
  const expected = {
    type: 'invalid_request_error',
    message: 'bad field',
    provider_specific_fields: {
      code: 400,
      status: 'INVALID_ARGUMENT',
      details: [{ reason: 'INVALID' }],
    },
  };

  expect(readGeminiGenerateContentErrorBody(httpError([googleError]))).toEqual(expected);
  expect(readGeminiGenerateContentErrorBody(httpError(googleError))).toEqual(expected);
  expect(geminiGenerateContentErrorFromEvent(googleError)).toEqual(expected);
  expect(readGeminiGenerateContentErrorBody(httpError([
    { error: { code: 400, message: 'first' } },
    { error: { code: 500, message: 'second' } },
  ]))).toBeUndefined();
});

test('maps numeric-only, status-only, explicit-type, unmapped, and message-less Google RPC errors', () => {
  expect(readGeminiGenerateContentErrorBody(httpError({ error: { code: 429, message: 'slow down' } }, 429))).toEqual({
    type: 'rate_limit_error',
    message: 'slow down',
    provider_specific_fields: { code: 429 },
  });
  expect(readGeminiGenerateContentErrorBody(httpError({ error: { status: 'ALREADY_EXISTS', msg: 'duplicate' } }, 409))).toEqual({
    type: 'conflict_error',
    message: 'duplicate',
    provider_specific_fields: { status: 'ALREADY_EXISTS' },
  });
  expect(readGeminiGenerateContentErrorBody(httpError({
    error: { code: 400, status: 'INVALID_ARGUMENT', type: 'custom_error', message: 'custom' },
  }))).toEqual({
    type: 'custom_error',
    message: 'custom',
    provider_specific_fields: { code: 400, status: 'INVALID_ARGUMENT' },
  });
  expect(readGeminiGenerateContentErrorBody(httpError({ error: { code: 418, status: 'TEAPOT', message: 'nope' } }, 418))).toEqual({
    message: 'nope',
    provider_specific_fields: { code: 418, status: 'TEAPOT' },
  });
  expect(readGeminiGenerateContentErrorBody(httpError({ error: { code: 429, status: '', message: 'rate limited' } }, 429))).toEqual({
    type: 'rate_limit_error',
    message: 'rate limited',
    provider_specific_fields: { code: 429, status: '' },
  });
  expect(readGeminiGenerateContentErrorBody(httpError({ error: { code: 429, status: 'RESOURCE_EXHAUSTED' } }, 429))).toBeUndefined();
  expect(geminiGenerateContentErrorFromEvent({ error: { code: 429, status: 'RESOURCE_EXHAUSTED' } })).toEqual({
    type: 'rate_limit_error',
    message: '',
    provider_specific_fields: { code: 429, status: 'RESOURCE_EXHAUSTED' },
  });
});

test('delegates non-numeric string error codes to standard error parsing without losing outer envelope fields', () => {
  const relayError = { request_id: 'req_1', error: { code: 'context_length_exceeded', message: 'too long' } };
  const expected = {
    code: 'context_length_exceeded',
    message: 'too long',
    provider_specific_fields: { request_id: 'req_1' },
  };
  expect(readGeminiGenerateContentErrorBody(httpError(relayError))).toEqual(expected);
  expect(geminiGenerateContentErrorFromEvent(relayError)).toEqual(expected);
});
