import { expect, test, vi } from 'vitest';

import { generateReply, messagesFixture, messagesPayload, messagesUpstream, requestPayload } from './fixture.ts';
import type { FetchInit } from '@floway-dev/http';
import { jsonResponse } from '@floway-dev/test-utils';

const beta = ['context-1m-2025-08-07', 'advanced-tool-use-2025-11-20'];
const headers = { 'anthropic-beta': beta.join(', ') };

test('generate routes a native Anthropic Messages candidate end to end', async () => {
  const seen: FetchInit[] = [];
  const fixture = messagesFixture([messagesUpstream({
    fetcher: async (_url, init) => {
      seen.push(init);
      return generateReply();
    },
  })]);
  const { response, done } = await fixture.send(messagesPayload({ stream: true }), {
    headers: { ...headers, authorization: 'Bearer sk-floway', 'x-api-key': 'sk-floway' },
  });
  expect(await response.text()).toContain('event: message_stop');
  expect(seen).toHaveLength(1);
  expect(new Headers(seen[0].headers).get('anthropic-beta')).toBe(beta.join(','));
  expect(new Headers(seen[0].headers).get('x-api-key')).toBe('test-key');
  const providerEntry = fixture.events.find(event => event.k === 'enter' && event.pipeline === 'custom.anthropicMessages');
  expect(providerEntry).toMatchObject({ facts: { 'request.anthropicBeta': beta, 'request.http': { headers: [] } } });
  expect(await done).toMatchObject({ ok: true });
});

test('generate filters out candidates with incompatible endpoints and renders model-unsupported as a 400', async () => {
  const upstream = vi.fn(async () => { throw new Error('unexpected provider call'); });
  const fixture = messagesFixture([messagesUpstream({
    endpoints: { openaiCompletions: {} }, fetcher: upstream,
  })], { failedUpstreams: ['failed catalog'] });
  const { response, done } = await fixture.send(messagesPayload({ model: 'wrong-endpoint-model' }));
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    request_id: expect.stringMatching(/^req_/), error: {
      type: 'invalid_request_error', message: expect.stringMatching(/wrong-endpoint-model does not support the \/messages endpoint.*failed catalog/s),
    },
  });
  expect(upstream).not.toHaveBeenCalled();
  expect(await done).toMatchObject({ ok: true });
});

test('countTokens proxies the upstream measurement response as a plain result', async () => {
  const seen: FetchInit[] = [];
  const fixture = messagesFixture([messagesUpstream({
    modelId: 'claude-target',
    fetcher: async (_url, init) => {
      seen.push(init);
      return jsonResponse({ input_tokens: 42 });
    },
  })]);
  const payload = messagesPayload({ model: 'claude-alias' });
  const { response, done } = await fixture.send(payload, { count: true, headers });
  expect(response.status).toBe(200);
  expect(await response.text()).toBe('{"input_tokens":42}');
  expect(requestPayload(seen[0]).model).toBe('claude-target');
  expect(new Headers(seen[0].headers).get('anthropic-beta')).toBe(beta.join(','));
  expect(payload.model).toBe('claude-alias');
  expect(await done).toMatchObject({ ok: true });
  expect(fixture.usage).toEqual([]);
});

test('generate failover preserves billing blocks and frozen messages for a strip-off candidate', async () => {
  const system = [
    { type: 'text' as const, text: 'x-anthropic-billing-header: per-turn-token\ncch=deadbeef1234;' },
    { type: 'text' as const, text: 'keep this' },
  ];
  const messages = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'original user text' }] }];
  const fixture = messagesFixture([
    messagesUpstream({
      upstreamId: 'strip', flags: ['strip-billing-attribution'],
      fetcher: async () => new Response('unavailable', { status: 503 }),
    }),
    messagesUpstream({ upstreamId: 'preserve' }),
  ]);
  const { response, done } = await fixture.send(messagesPayload({ system, messages }));
  expect(response.status).toBe(200);
  expect(await done).toMatchObject({ ok: true });
  const seen = fixture.events.flatMap(event => event.k === 'enter' && event.pipeline === 'custom.anthropicMessages' && event.name === 'parseSse'
    ? [event.facts['request.payload']]
    : []);
  expect(seen).toMatchObject([{ system: [system[1]], messages }, { system, messages }]);
  const [first] = seen;
  if (first === null || typeof first !== 'object' || !('messages' in first) || !Array.isArray(first.messages)) {
    throw new Error('Expected a provider payload with frozen messages');
  }
  expect(Object.isFrozen(first.messages[0].content[0])).toBe(true);
  expect(fixture.usage.map(row => row.upstream)).toEqual(['preserve']);
});

test('alias resolution swaps the inbound model id for the target and overlays native rules', async () => {
  const seen: FetchInit[] = [];
  const fixture = messagesFixture([messagesUpstream({
    modelId: 'claude-opus-4-7', rules: { reasoning: { effort: 'high', budget_tokens: 2048 }, serviceTier: 'fast' },
    fetcher: async (_url, init) => {
      seen.push(init);
      return generateReply();
    },
  })]);
  const { response, done } = await fixture.send(messagesPayload({ model: 'claude-fast' }));
  expect(response.status).toBe(200);
  expect(await done).toMatchObject({ ok: true });
  expect(fixture.requestedModels).toEqual(['claude-fast']);
  expect(requestPayload(seen[0])).toMatchObject({
    model: 'claude-opus-4-7', output_config: { effort: 'high' }, thinking: { type: 'enabled', budget_tokens: 2048 }, speed: 'fast',
  });
});
