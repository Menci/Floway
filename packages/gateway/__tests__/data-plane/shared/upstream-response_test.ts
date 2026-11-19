import { expect, test } from 'vitest';

import { forwardUpstreamResponse, isForwardableUpstreamHeader, mergeForwardedUpstreamHeaders, providerModelsUnavailableResponse } from '../../../src/data-plane/shared/upstream-response.ts';
import { ProviderModelsUnavailableError } from '@floway-dev/provider';

test('upstream response header policy preserves vendor metadata and blocks unsafe fields', () => {
  expect(isForwardableUpstreamHeader('x-api-warning')).toBe(true);
  expect(isForwardableUpstreamHeader('content-length')).toBe(false);
  expect(isForwardableUpstreamHeader('set-cookie')).toBe(false);

  const headers = mergeForwardedUpstreamHeaders(
    { 'x-base': 'base' },
    new Headers({ 'x-vendor': 'vendor', 'set-cookie': 'secret=1', 'content-type': 'text/plain' }),
  );
  expect(Object.fromEntries(headers)).toEqual({ 'x-base': 'base', 'x-vendor': 'vendor' });
});

test('forwardUpstreamResponse supports raw and replaced bodies with configurable content-type fallback', async () => {
  const upstream = new Response('raw', {
    status: 201,
    headers: { 'content-type': 'text/plain', 'x-vendor': 'vendor', 'set-cookie': 'secret=1' },
  });
  const raw = forwardUpstreamResponse(upstream.clone());
  expect(raw.status).toBe(201);
  expect(raw.headers.get('content-type')).toBe('text/plain');
  expect(raw.headers.get('x-vendor')).toBe('vendor');
  expect(raw.headers.get('set-cookie')).toBeNull();
  expect(await raw.text()).toBe('raw');

  const replaced = forwardUpstreamResponse(upstream, { body: 'replacement' });
  expect(await replaced.text()).toBe('replacement');

  const untyped = new Response(Uint8Array.of(1));
  expect(forwardUpstreamResponse(untyped.clone()).headers.get('content-type')).toBe('application/json');
  expect(forwardUpstreamResponse(untyped, { defaultContentType: null }).headers.get('content-type')).toBeNull();
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
