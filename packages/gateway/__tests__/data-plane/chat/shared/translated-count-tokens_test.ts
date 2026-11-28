import { expect, test, vi } from 'vitest';

import { reshapeTranslatedCountTokens } from '../../../../src/data-plane/chat/shared/translated-count-tokens.ts';
import {
  decodeResponseBody,
  internalErrorResult,
  plainResult,
  toInternalDebugError,
  type ApiErrorResult,
  type PerformanceTelemetryContext,
} from '@floway-dev/upstream';

const encoder = new TextEncoder();
const perf = { upstreamId: 'up_1', modelId: 'm', operation: 'chat' } as unknown as PerformanceTelemetryContext;

const baseOptions = () => ({
  translateError: vi.fn(() => undefined as { status: number; headers: Headers; body: unknown } | undefined),
  fallbackErrorBody: (status: number, message: string) => ({ fallback: { status, message } }),
  extractCount: (decoded: Record<string, unknown>) => decoded.totalTokens,
  encodeCount: (count: number) => ({ input_tokens: count }),
  performance: perf,
});

test('passes through internal-error and empty 204/205/304 plain responses untouched', () => {
  const internal = internalErrorResult(502, toInternalDebugError(new Error('boom')), perf);
  expect(reshapeTranslatedCountTokens(internal, baseOptions())).toBe(internal);

  for (const status of [204, 205, 304]) {
    const empty = plainResult({ status, headers: new Headers() }, null, 'up_1');
    expect(reshapeTranslatedCountTokens(empty, baseOptions())).toBe(empty);
  }
});

test('reshapes valid 200 JSON count responses while preserving upstream headers and upstreamId', () => {
  const result = reshapeTranslatedCountTokens(
    plainResult(
      { status: 200, headers: new Headers({ 'content-type': 'text/plain', 'x-trace-id': 't-1' }) },
      encoder.encode(JSON.stringify({ totalTokens: 73 })),
      'up_1',
    ),
    baseOptions(),
  );
  expect(result.type).toBe('plain');
  if (result.type !== 'plain') throw new Error('unreachable');
  expect(result.http.status).toBe(200);
  expect(result.http.headers.get('content-type')).toBe('application/json');
  expect(result.http.headers.get('x-trace-id')).toBe('t-1');
  expect(result.upstreamId).toBe('up_1');
  expect(JSON.parse(decodeResponseBody(result.body))).toEqual({ input_tokens: 73 });
});

test('returns 502 internal-error with performance and parse cause on malformed 200 bodies', () => {
  const invalidJson = reshapeTranslatedCountTokens(
    plainResult({ status: 200, headers: new Headers() }, encoder.encode('not-json'), 'up_1'),
    baseOptions(),
  );
  expect(invalidJson.type).toBe('internal-error');
  if (invalidJson.type !== 'internal-error') throw new Error('unreachable');
  expect(invalidJson.http.status).toBe(502);
  expect(invalidJson.performance).toBe(perf);
  expect(invalidJson.error.message).toBe('Invalid upstream token counting response.');
  expect(invalidJson.error.cause).toMatchObject({ name: 'SyntaxError' });

  for (const payload of ['[]', '{"totalTokens":"42"}']) {
    const invalidShape = reshapeTranslatedCountTokens(
      plainResult({ status: 200, headers: new Headers() }, encoder.encode(payload), 'up_1'),
      baseOptions(),
    );
    expect(invalidShape.type).toBe('internal-error');
    if (invalidShape.type !== 'internal-error') throw new Error('unreachable');
    expect(invalidShape.http.status).toBe(502);
    expect(invalidShape.performance).toBe(perf);
  }

  const nonFinite = reshapeTranslatedCountTokens(
    plainResult({ status: 200, headers: new Headers() }, encoder.encode('{}'), 'up_1'),
    { ...baseOptions(), extractCount: () => Number.POSITIVE_INFINITY },
  );
  expect(nonFinite.type).toBe('internal-error');
});

test('translates errors, applies fallback messaging, preserves api-error metadata, and gates dump capture on upstream origin', () => {
  const capture = { upstreamApiError: vi.fn(), upstreamFrame: vi.fn() };
  const opts = {
    ...baseOptions(),
    capture,
    translateError: vi.fn((status: number, headers: Headers) =>
      status === 429
        ? { status: 429, headers: new Headers({ 'retry-after': headers.get('retry-after') ?? '0' }), body: { translated: true } }
        : undefined),
  };

  const upstreamApiErr: ApiErrorResult = {
    type: 'api-error',
    source: 'upstream',
    upstreamId: 'up_1',
    performance: perf,
    http: { status: 429, headers: new Headers({ 'retry-after': '7' }) },
    body: encoder.encode('{"error":{"message":"slow"}}'),
  };
  const translated = reshapeTranslatedCountTokens(upstreamApiErr, opts);
  expect(translated.type).toBe('api-error');
  if (translated.type !== 'api-error') throw new Error('unreachable');
  expect(translated.source).toBe('upstream');
  expect(translated.upstreamId).toBe('up_1');
  expect(translated.performance).toBe(perf);
  expect(translated.http.status).toBe(429);
  expect(translated.http.headers.get('retry-after')).toBe('7');
  expect(JSON.parse(decodeResponseBody(translated.body))).toEqual({ translated: true });
  expect(capture.upstreamApiError).toHaveBeenCalledTimes(1);

  capture.upstreamApiError.mockClear();
  const gatewayApiErr: ApiErrorResult = {
    type: 'api-error',
    source: 'gateway',
    http: { status: 400, headers: new Headers() },
    body: encoder.encode('   '),
  };
  const gatewayFallback = reshapeTranslatedCountTokens(gatewayApiErr, opts);
  expect(gatewayFallback.type).toBe('api-error');
  if (gatewayFallback.type !== 'api-error') throw new Error('unreachable');
  expect(gatewayFallback.source).toBe('gateway');
  expect(JSON.parse(decodeResponseBody(gatewayFallback.body))).toEqual({
    fallback: { status: 400, message: 'Upstream token counting request failed.' },
  });
  expect(capture.upstreamApiError).not.toHaveBeenCalled();

  const upstreamPlainErr = reshapeTranslatedCountTokens(
    plainResult({ status: 503, headers: new Headers() }, encoder.encode('  overloaded  '), 'up_1'),
    opts,
  );
  expect(upstreamPlainErr.type).toBe('plain');
  if (upstreamPlainErr.type !== 'plain') throw new Error('unreachable');
  expect(upstreamPlainErr.upstreamId).toBe('up_1');
  expect(JSON.parse(decodeResponseBody(upstreamPlainErr.body))).toEqual({
    fallback: { status: 503, message: 'overloaded' },
  });
  expect(capture.upstreamApiError).toHaveBeenCalledTimes(1);

  capture.upstreamApiError.mockClear();
  reshapeTranslatedCountTokens(plainResult({ status: 503, headers: new Headers() }, encoder.encode('local')), opts);
  expect(capture.upstreamApiError).not.toHaveBeenCalled();

  capture.upstreamApiError.mockClear();
  const { fallbackErrorBody: _fallback, ...passthroughOpts } = opts;
  const htmlUpstreamErr = plainResult(
    { status: 504, headers: new Headers({ 'content-type': 'text/html' }) },
    encoder.encode('<html>504</html>'),
    'up_1',
  );
  expect(reshapeTranslatedCountTokens(htmlUpstreamErr, passthroughOpts)).toBe(htmlUpstreamErr);
  expect(capture.upstreamApiError).toHaveBeenCalledTimes(1);
});
