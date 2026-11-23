import { expect, test } from 'vitest';

import { edgeHttp, type HttpDeliveryFacts, type HttpInput, type HttpOutput } from '../../../src/data-plane/pipeline/edge-http.ts';
import { forwardHttp } from '../../../src/data-plane/pipeline/non-chat.ts';
import { writeHttpResponse } from '../../../src/data-plane/shared/http-writer.ts';
import { isForwardableUpstreamHeader, providerModelsUnavailableResponse } from '../../../src/data-plane/shared/upstream-response.ts';
import type { HttpResponseBodyChunk } from '@floway-dev/http';
import { Bytes, compose, defineEnding, run, snapshotError } from '@floway-dev/pipeline';
import { ProviderModelsUnavailableError } from '@floway-dev/provider';

test('upstream response header policy preserves vendor metadata and blocks unsafe fields', () => {
  expect(isForwardableUpstreamHeader('x-api-warning')).toBe(true);
  expect(isForwardableUpstreamHeader('content-length')).toBe(false);
  expect(isForwardableUpstreamHeader('set-cookie')).toBe(false);
});

test('forwardHttp preserves raw bytes and applies the configured content-type fallback', async () => {
  const upstream = {
    status: 201, statusText: '', body: Bytes.fromUtf8('raw'), timing: { startedAt: 0, headersAt: 0 },
    headers: [['content-type', 'text/plain'], ['x-vendor', 'vendor'], ['set-cookie', 'secret=1']] as const,
  };
  const raw = writeHttpResponse(forwardHttp(upstream));
  expect(raw.status).toBe(201);
  expect(raw.headers.get('content-type')).toBe('text/plain');
  expect(raw.headers.get('x-vendor')).toBe('vendor');
  expect(raw.headers.get('set-cookie')).toBeNull();
  expect(await raw.text()).toBe('raw');

  const untyped = { ...upstream, headers: [] };
  expect(writeHttpResponse(forwardHttp(untyped)).headers.get('content-type')).toBe('application/json');
  expect(writeHttpResponse(forwardHttp(untyped, null)).headers.get('content-type')).toBeNull();
});

test('model-list failures use the same outbound header filtering', async () => {
  const error = new ProviderModelsUnavailableError({
    status: 429,
    headers: new Headers({ 'content-encoding': 'gzip', 'set-cookie': 'private=1', 'retry-after': '12' }),
    body: 'please retry',
  });
  const response = providerModelsUnavailableResponse(error);
  if (response === null) throw new Error('expected upstream HTTP response');
  expect(response.status).toBe(429);
  expect(response.headers.get('retry-after')).toBe('12');
  expect(response.headers.get('content-encoding')).toBeNull();
  expect(response.headers.get('set-cookie')).toBeNull();
  expect(await response.text()).toBe('please retry');
});

test('a mid-body transport failure aborts passthrough delivery and settles the pipeline', async () => {
  const failure = snapshotError(new Error('upstream socket reset'));
  const pipeline = compose<HttpInput & HttpOutput & HttpDeliveryFacts>()('test.passthrough', {
    entry: ['request.http'],
    exit: ['response.http', 'response.delivery'],
    stages: [edgeHttp],
    ending: defineEnding<HttpInput, HttpOutput>({
      name: 'upstream',
      request: { needs: [] },
      return: { provides: ['response.http'] },
      execute: async (_facts, scope) => ({
        'response.http': {
          status: 200, statusText: '', headers: [], timing: { startedAt: 0, headersAt: 1 },
          body: scope.createStream<HttpResponseBodyChunk>({
            label: 'upstream body',
            async *iterate() {
              yield Bytes.fromUtf8('partial');
              yield { type: 'transport-error', error: failure };
            },
          }),
        },
      }),
    }),
  });
  const handle = run(pipeline, {
    'request.http': { method: 'GET', url: { origin: 'https://test.example', pathname: '/test' }, headers: [], body: null },
  }, { services: {}, finalizationTimeoutMs: 1_000 });
  const output = await handle.result;
  const reader = writeHttpResponse(output['response.http']).body?.getReader();
  if (reader === undefined) throw new Error('Expected downstream body');
  const first = await reader.read();
  expect(new TextDecoder().decode(first.value)).toBe('partial');
  await expect(reader.read()).rejects.toThrow(failure.message);
  await expect(output['response.delivery'].promise).resolves.toMatchObject({ kind: 'write-failed', error: failure });
  await expect(handle.done).resolves.toEqual({ ok: true });
});
