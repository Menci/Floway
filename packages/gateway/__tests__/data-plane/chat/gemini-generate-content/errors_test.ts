import { test } from 'vitest';

import { inputErrorResult, normalizeGeminiGenerateContentFailure } from '../../../../src/data-plane/chat/gemini-generate-content/errors.ts';
import { assertEquals } from '@floway-dev/test-utils';
import { decodeResponseBody, internalErrorResult, toInternalDebugError } from '@floway-dev/upstream';

const bodyOf = (result: ReturnType<typeof inputErrorResult>): Record<string, unknown> =>
  JSON.parse(decodeResponseBody(result.body));

test('inputErrorResult renders a GenerateContent 400 INVALID_ARGUMENT envelope', () => {
  const result = inputErrorResult({ message: '"inlineData" parts are not supported in user content.' });
  assertEquals(result.type, 'api-error');
  assertEquals(result.source, 'gateway');
  assertEquals(result.http.status, 400);
  assertEquals(result.http.headers.get('content-type'), 'application/json');
  assertEquals(bodyOf(result).error, {
    code: 400,
    message: '"inlineData" parts are not supported in user content.',
    status: 'INVALID_ARGUMENT',
  });
});

test.each([
  { name: 'field and code', fields: { param: 'model', code: 'missing_required_parameter' }, expected: { param: 'model', code: 'missing_required_parameter' } },
  { name: 'neither field nor code', fields: {}, expected: undefined },
])('inputErrorResult preserves $name exactly', ({ fields, expected }) => {
  const result = inputErrorResult({ message: 'invalid input', ...fields });
  // We preserve the translator's field and code in a Struct Any inside details.
  assertEquals(bodyOf(result).error, {
    code: 400,
    message: 'invalid input',
    status: 'INVALID_ARGUMENT',
    ...(expected === undefined ? {} : {
      details: [{ '@type': 'type.googleapis.com/google.protobuf.Struct', value: expected }],
    }),
  });
});

test('normalizeGeminiGenerateContentFailure unwraps single-element stream error arrays and normalizes unrecognized bodies', () => {
  const encoder = new TextEncoder();
  const singleArrayBody = encoder.encode(JSON.stringify([
    { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota exceeded' } },
  ]));
  const unwrapped = normalizeGeminiGenerateContentFailure({
    type: 'api-error',
    source: 'upstream',
    http: { status: 500, headers: new Headers({ 'content-type': 'application/json' }) },
    body: singleArrayBody,
  });
  assertEquals(unwrapped.type, 'api-error');
  if (unwrapped.type !== 'api-error') throw new Error('unreachable');
  assertEquals(unwrapped.http.status, 429);
  assertEquals(unwrapped.body, singleArrayBody);

  const multiArray = normalizeGeminiGenerateContentFailure({
    type: 'api-error',
    source: 'upstream',
    http: { status: 504, headers: new Headers({ 'content-type': 'application/json' }) },
    body: encoder.encode(JSON.stringify([
      { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'a' } },
      { error: { code: 500, status: 'INTERNAL', message: 'b' } },
    ])),
  });
  assertEquals(multiArray.type, 'api-error');
  if (multiArray.type !== 'api-error') throw new Error('unreachable');
  assertEquals(multiArray.http.status, 500);
  assertEquals(JSON.parse(decodeResponseBody(multiArray.body)).error.status, 'INTERNAL');

  const gatewayErr = inputErrorResult({ message: 'bad request' });
  assertEquals(normalizeGeminiGenerateContentFailure(gatewayErr), gatewayErr);

  const unlistedInternal = normalizeGeminiGenerateContentFailure(internalErrorResult(504, toInternalDebugError(new Error('timeout'))));
  assertEquals(unlistedInternal.type, 'internal-error');
  assertEquals(unlistedInternal.http.status, 500);

  const listedInternal = internalErrorResult(502, toInternalDebugError(new Error('bad gateway')));
  assertEquals(normalizeGeminiGenerateContentFailure(listedInternal), listedInternal);
});
