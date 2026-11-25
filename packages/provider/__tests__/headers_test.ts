import { expect, it } from 'vitest';

import { stripHeaders } from '../src/headers.ts';
import type { HttpRequestFact } from '@floway-dev/http';
import { factSpace, move, run, Secret } from '@floway-dev/pipeline';

const { compose, defineStage } = factSpace<{
  readonly 'request.http': HttpRequestFact;
  readonly 'response.request': HttpRequestFact;
}>();

const ending = defineStage({
  name: 'echoRequest',
  request: { needs: ['request.http'] },
  return: { provides: ['response.request'] },
  async execute(facts) {
    return { 'response.request': facts['request.http'] };
  },
});

const pipeline = compose('headers', {
  entry: ['request.http'],
  exit: ['response.request'],
  stages: [stripHeaders('keepForwardedHeaders', name => name === 'x-forward')],
  ending,
});

it('keeps only the provider-selected field names with order and value identity intact', async () => {
  const body = { messages: ['hello'] };
  const request = move<HttpRequestFact>({
    method: 'POST',
    url: 'https://example.test/',
    headers: [['X-Forward', 'one'], ['Authorization', Secret.from('credential')], ['x-forward', 'two']],
    body,
  });
  const exchange = run(pipeline, { 'request.http': request }, { services: {} });

  const { 'response.request': received } = await exchange.result;
  await exchange.done;

  expect(received).toEqual({ ...request, headers: [['X-Forward', 'one'], ['x-forward', 'two']] });
  expect(received.headers[0]).toBe(request.headers[0]);
  expect(received.body).toBe(body);
});

it('passes the original HTTP request through when no headers are removed', async () => {
  const request = move<HttpRequestFact>({
    method: 'POST', url: 'https://example.test/', headers: [['X-Forward', 'one']], body: null,
  });
  const exchange = run(pipeline, { 'request.http': request }, { services: {} });

  expect((await exchange.result)['response.request']).toBe(request);
  await exchange.done;
});
