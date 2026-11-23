import { expect, test } from 'vitest';

import {
  deleteHeader,
  httpTerminal,
  httpUrl,
  rewriteHttpRequest,
  rewriteHttpRequestStage,
  stripHttpHeaders,
  type HttpRequestFacts,
  type ProviderBaseOutput,
  type ProviderServices,
  type ProviderUpstreamBase,
} from '../src/index.ts';
import { Bytes, compose, run } from '@floway-dev/pipeline';

type Input = { readonly 'request.http': HttpRequestFacts; readonly 'provider.upstream': ProviderUpstreamBase };
type Services = ProviderServices & { readonly providerHeader: string };

const request: HttpRequestFacts = {
  method: 'PUT',
  url: httpUrl('https://gateway.test/submit'),
  headers: [['X-Client', 'incoming'], ['Content-Type', 'text/plain'], ['X-Discard', 'discard'], ['X-Second', 'preserved']],
  body: Bytes.fromUtf8('inbound bytes'),
};

test('filters rewritten HTTP headers by their lowercase names immediately before dispatch', async () => {
  const pipeline = compose<Input & ProviderBaseOutput, Services>()('test.rewrite', {
    entry: ['provider.upstream', 'request.http'],
    exit: ['response.http', 'response.modelKey'],
    stages: [
      rewriteHttpRequestStage<Input, Services>('rewrite', ['request.http'], (_facts, scope) => ({
        request: {
          method: 'POST',
          url: httpUrl('https://upstream.test/submit'),
          headers: [['x-client', 'rewritten'], ['X-Provider', scope.services.providerHeader], ['x-provider-internal', 'discard']],
          body: { kind: 'json', value: { model: 'actual-model' } },
        },
        modelKey: 'actual-model',
      })),
      stripHttpHeaders(name => ['x-client', 'x-second', 'content-type', 'x-provider'].includes(name)),
    ],
    ending: httpTerminal,
  });
  const handle = run(pipeline, {
    'provider.upstream': { id: 'test-upstream', kind: 'custom', name: 'Test Upstream', config: {} },
    'request.http': request,
  }, {
    finalizationTimeoutMs: 200,
    services: {
      providerHeader: 'provider',
      fetcher: () => async (url, init) => {
        expect(url).toBe('https://upstream.test/submit');
        expect(init.method).toBe('POST');
        expect(init.headers).toEqual([
          ['X-Client', 'rewritten'], ['Content-Type', 'application/json'], ['X-Second', 'preserved'], ['X-Provider', 'provider'],
        ]);
        expect(init.body).toEqual(new TextEncoder().encode('{"model":"actual-model"}'));
        return new Response(null, { status: 204 });
      },
    },
  });
  await expect(handle.result).resolves.toMatchObject({ 'response.http': { status: 204 }, 'response.modelKey': 'actual-model' });
  await expect(handle.done).resolves.toEqual({ ok: true });
  expect(request.headers).toContainEqual(['X-Discard', 'discard']);
});

test('lets a rewrite apply a header deletion to the current headers and retain a byte body', () => {
  const body = Bytes.fromUtf8('upstream bytes');
  const rewritten = rewriteHttpRequest(request, {
    method: 'POST',
    url: request.url,
    headers: headers => deleteHeader(headers, 'x-discard'),
    body,
  });
  expect(rewritten.body).toBe(body);
  expect(rewritten.headers).toEqual([['X-Client', 'incoming'], ['Content-Type', 'text/plain'], ['X-Second', 'preserved']]);
});
