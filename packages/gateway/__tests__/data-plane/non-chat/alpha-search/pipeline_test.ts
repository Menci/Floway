import { expect, test, vi } from 'vitest';

import { alphaSearchIngress, alphaSearchOperation } from '../../../../src/data-plane/non-chat/alpha-search/index.ts';
import { customCandidate, post, setupNonChat } from '../fixtures.ts';
import { getHeader, type Fetcher } from '@floway-dev/http';
import { run, secret } from '@floway-dev/pipeline';

test('alpha search pins configured model lookup and keeps passthrough result bytes', async () => {
  const candidate = customCandidate('search', {});
  const bytes = '{ "encrypted_output": null, "output": "passthrough", "unknown": 9007199254740993 }';
  const fetcher = vi.fn<Fetcher>(async () => new Response(bytes, { headers: { 'content-type': 'application/json', 'x-request-id': 'search-id' } }));
  const fixture = await setupNonChat([candidate], () => fetcher);
  fixture.services.localWebSearch.passthroughConfiguration = async () => ({ enabled: true, upstreamId: 'search', model: 'configured-model' });
  const host = fixture.host();
  const running = run(alphaSearchOperation, {
    ...post(null, '/alpha/search'),
    alphaSearch: { model: 'caller-model', commands: { image_query: [{ q: 'a tree' }] } },
  }, host.options);

  const answer = await running.result;
  expect(fixture.catalogCandidates).toHaveBeenCalledExactlyOnceWith({ model: 'configured-model', kind: 'chat', upstreamId: 'search' });
  expect(fetcher).toHaveBeenCalledOnce();
  expect(JSON.parse(String(fetcher.mock.calls[0]?.[1].body))).toEqual({
    model: 'wire-model', commands: { image_query: [{ q: 'a tree' }] },
  });
  expect(answer.candidate?.upstreamId).toBe('search');
  expect(getHeader(answer.http?.headers ?? [], 'x-request-id')).toBe('search-id');
  if (answer.alphaSearch.kind !== 'result' || !(answer.alphaSearch.result instanceof Uint8Array) || answer.usage === undefined) {
    throw new Error('Expected a byte-exact Alpha Search result');
  }
  expect(new TextDecoder().decode(answer.alphaSearch.result)).toBe(bytes);
  await expect(running.read(answer.usage)).resolves.toEqual({ kind: 'observed', usage: [] });
  host.controller.abort();
  running.discard(answer);
  await host.settle();
  expect(host.errors).toEqual([]);
  expect(fixture.recordUsage).not.toHaveBeenCalled();
  expect(fixture.recordPerformance).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ operation: 'alpha_search', failed: false }));
});

test('alpha search HTTP preserves the selected body and end-to-end response headers', async () => {
  const body = '{"output":"decoded"}';
  const fixture = await setupNonChat([customCandidate('search', {})], () => async () => new Response(body, {
    status: 202,
    statusText: 'Accepted upstream',
    headers: {
      connection: 'close',
      'content-encoding': 'gzip',
      'content-length': '999',
      'content-type': 'application/json',
      'set-cookie': 'session=upstream-test',
      'transfer-encoding': 'chunked',
      'x-oai-request-id': 'req_search_1',
    },
  }));
  fixture.services.localWebSearch.passthroughConfiguration = async () => ({ enabled: true, upstreamId: 'search', model: 'configured-model' });
  const host = fixture.host();
  const running = run(alphaSearchIngress, post({ commands: {} }, '/alpha/search'), host.options);
  const answer = await running.result;
  expect(answer.http).toMatchObject({ status: 202, statusText: 'Accepted upstream', body: new TextEncoder().encode(body) });
  expect(answer.http?.headers).toEqual([
    ['content-type', 'application/json'],
    ['x-oai-request-id', 'req_search_1'],
  ]);
  host.controller.abort();
  running.discard(answer);
  await host.settle();
  expect(host.errors).toEqual([]);
});

test('alpha search local validation and empty commands avoid model lookup', async () => {
  const fixture = await setupNonChat([], () => { throw new Error('Unexpected dial'); });
  fixture.services.localWebSearch.passthroughConfiguration = async () => ({ enabled: false, upstreamId: '', model: '' });
  const host = fixture.host();
  const running = run(alphaSearchIngress, post({ commands: {} }, '/alpha/search'), host.options);
  const answer = await running.result;
  expect(answer.http?.status).toBe(200);
  if (!(answer.http?.body instanceof Uint8Array)) throw new Error('Expected the local Alpha Search response');
  expect(JSON.parse(new TextDecoder().decode(answer.http.body))).toEqual({
    encrypted_output: null,
    output: 'No web search commands were provided. Populate at least one of `search_query`, `open`, or `find`.',
  });
  host.controller.abort();
  running.discard(answer);
  await host.settle();
  expect(host.errors).toEqual([]);
  expect(fixture.catalogCandidates).not.toHaveBeenCalled();
  expect(fixture.recordPerformance).not.toHaveBeenCalled();
});

test('alpha search surfaces an unsupported upstream kind as configuration failure', async () => {
  const candidate = customCandidate('search', {});
  const fixture = await setupNonChat([{ ...candidate, upstream: { ...candidate.upstream, kind: 'copilot' } }], () => {
    throw new Error('Unexpected dial');
  });
  fixture.services.localWebSearch.passthroughConfiguration = async () => ({ enabled: true, upstreamId: 'search', model: 'configured-model' });
  const host = fixture.host();
  const running = run(alphaSearchOperation, { ...post(null, '/alpha/search'), alphaSearch: {} }, host.options);
  await expect(running.result).rejects.toThrow('Selected upstream does not support OpenAI search passthrough');
  host.controller.abort();
  await host.settle();
  expect(host.errors).toEqual([]);
});

test('ChatGPT alpha search receives the caller turn metadata and its own authorization', async () => {
  const candidate = customCandidate('search', {});
  const fetcher = vi.fn<Fetcher>(async () => Response.json({ output: 'ok' }));
  const fixture = await setupNonChat([{ ...candidate, upstream: { ...candidate.upstream, kind: 'chatgpt' } }], () => fetcher);
  fixture.services.localWebSearch.passthroughConfiguration = async () => ({ enabled: true, upstreamId: 'search', model: 'configured-model' });
  fixture.services.chatgpt = {
    authorize: async () => ({
      kind: 'authorized',
      bearer: secret('Bearer upstream-key'),
      accountId: 'account',
      installationId: 'installation',
      reject: () => { throw new Error('Unexpected authorization rejection'); },
    }),
    observeQuota: async () => {},
  };
  const host = fixture.host();
  const request = post(null, '/alpha/search');
  const turn = '{"turn_id":"turn-1"}';
  const running = run(alphaSearchOperation, {
    ...request,
    http: {
      ...request.http,
      headers: [['authorization', 'Bearer gateway-key'], ['x-codex-turn-metadata', turn], ['x-debug', 'discard']],
    },
    alphaSearch: {},
  }, host.options);
  const answer = await running.result;
  expect(answer.alphaSearch.kind).toBe('result');
  expect(fetcher).toHaveBeenCalledOnce();
  const headers = new Headers(fetcher.mock.calls[0]?.[1].headers);
  expect(headers.get('authorization')).toBe('Bearer upstream-key');
  expect(headers.get('x-codex-turn-metadata')).toBe(turn);
  expect(headers.has('x-debug')).toBe(false);
  host.controller.abort();
  running.discard(answer);
  await host.settle();
  expect(host.errors).toEqual([]);
});
