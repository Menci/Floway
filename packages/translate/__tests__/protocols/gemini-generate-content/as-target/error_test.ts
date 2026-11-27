import { expect, test } from 'vitest';

import {
  geminiGenerateContentErrorPayloadFromWire,
  readGeminiGenerateContentErrorBody,
} from '../../../../src/protocols/gemini-generate-content/as-target/error.ts';

const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

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

  expect(readGeminiGenerateContentErrorBody(encode([googleError]))).toEqual(expected);
  expect(readGeminiGenerateContentErrorBody(encode(googleError))).toEqual(expected);
  expect(geminiGenerateContentErrorPayloadFromWire(googleError)).toEqual(expected);
  expect(readGeminiGenerateContentErrorBody(encode([
    { error: { code: 400, message: 'first' } },
    { error: { code: 500, message: 'second' } },
  ]))).toBeUndefined();
  expect(readGeminiGenerateContentErrorBody(encode([{ ok: true }]))).toBeUndefined();
});

test('delegates non-numeric string error codes to standard error parsing', () => {
  const relayError = { error: { code: 'context_length_exceeded', message: 'too long' } };
  expect(readGeminiGenerateContentErrorBody(encode(relayError))).toEqual({
    code: 'context_length_exceeded',
    message: 'too long',
  });
  expect(geminiGenerateContentErrorPayloadFromWire(relayError)).toEqual({
    code: 'context_length_exceeded',
    message: 'too long',
  });
});
