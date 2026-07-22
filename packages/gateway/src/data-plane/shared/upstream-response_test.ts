import { Hono } from 'hono';
import { expect, test } from 'vitest';

import { forwardUpstreamHeaders, forwardUpstreamResponse, isForwardableUpstreamHeader, mergeForwardedUpstreamHeaders } from './upstream-response.ts';

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

test('forwardUpstreamHeaders stages safe headers on Hono responses', async () => {
  const app = new Hono();
  app.get('/', c => {
    forwardUpstreamHeaders(c, new Headers({ 'x-vendor': 'vendor', 'set-cookie': 'secret=1' }));
    return c.text('ok');
  });

  const response = await app.request('/');
  expect(response.headers.get('x-vendor')).toBe('vendor');
  expect(response.headers.get('set-cookie')).toBeNull();
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
