import { expect, test } from 'vitest';

import { adaptProviderFetcher, isUpstreamTransportError, runUpstreamTransport, UpstreamTransportError } from '../../src/dial/transport-error.ts';
import { ProxyDialError } from '@floway-dev/proxy';

test('network failures retain their original cause and successful responses retain their identity', async () => {
  const cause = new TypeError('connection reset');
  await expect(runUpstreamTransport(async () => { throw cause; })).rejects.toMatchObject({ name: UpstreamTransportError.name, cause });
  const response = new Response('ok');
  expect(await runUpstreamTransport(async () => response)).toBe(response);
});

test('transport classification excludes cancellations, configuration errors and mixed internal failures', async () => {
  const abort = new DOMException('cancelled', 'AbortError');
  const dial = new ProxyDialError('refused', 'tcp-connect');
  await expect(runUpstreamTransport(async () => { throw abort; })).rejects.toBe(abort);
  await expect(runUpstreamTransport(async () => { throw dial; })).rejects.toBe(dial);
  expect(isUpstreamTransportError(new AggregateError([dial, new UpstreamTransportError(new Error('fetch failed'))]))).toBe(true);
  for (const error of [abort, new ProxyDialError('invalid proxy', 'config'), new AggregateError([]), new AggregateError([dial, new Error('repo failed')])]) {
    expect(isUpstreamTransportError(error)).toBe(false);
  }
});

test('a response body failure stays outside the pre-response transport boundary', async () => {
  const cause = new Error('stream disconnected');
  const response = await runUpstreamTransport(async () => new Response(new ReadableStream({
    start(controller) { controller.error(cause); },
  })));
  await expect(response.text()).rejects.toBe(cause);
});

test('the provider fetcher reports only named transport and direct abort failures', async () => {
  const url = 'https://upstream.test';
  const transport = new UpstreamTransportError(new Error('connection reset'));
  const send = adaptProviderFetcher(() => async () => { throw transport; });
  await expect(send(url, { method: 'GET' })).resolves.toEqual({ ok: false, error: { kind: 'transport', cause: transport } });

  const abort = new AbortController();
  const reason = new Error('stop');
  const cancelled = adaptProviderFetcher(() => async () => { abort.abort(reason); throw reason; });
  await expect(cancelled(url, { method: 'GET', signal: abort.signal })).resolves.toEqual({ ok: false, error: { kind: 'abort', cause: reason } });

  const signal = new AbortController();
  const bug = new TypeError('fetcher bug');
  const panic = adaptProviderFetcher(() => async () => { signal.abort(); throw bug; });
  await expect(panic(url, { method: 'GET', signal: signal.signal })).rejects.toBe(bug);
});
