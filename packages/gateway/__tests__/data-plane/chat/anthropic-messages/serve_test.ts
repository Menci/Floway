import { expect, test, vi } from 'vitest';

import { countProvider, generateProvider, generateReply, httpReply, messagesFixture, messagesPayload, messagesUpstream } from './fixture.ts';
import { Bytes } from '@floway-dev/pipeline';
import type { ProviderAnthropicInput } from '@floway-dev/provider';

const beta = ['context-1m-2025-08-07', 'advanced-tool-use-2025-11-20'];
const headers = { 'anthropic-beta': beta.join(', ') };

test('generate routes a native Anthropic Messages candidate end to end', async () => {
  const seen: ProviderAnthropicInput[] = [];
  const fixture = messagesFixture([messagesUpstream({
    pipelines: {
      anthropicMessages: generateProvider((facts, env) => {
        seen.push(facts);
        return generateReply(env);
      }),
    },
  })]);
  const { response, done } = await fixture.send(messagesPayload({ stream: true }), { headers });
  expect(await response.text()).toContain('event: message_stop');
  expect(seen).toHaveLength(1);
  expect(seen[0]?.['request.anthropicBeta']).toEqual(beta);
  expect(seen[0]?.['request.headers']).toEqual([]);
  expect(await done).toMatchObject({ ok: true });
});

test('generate filters out candidates with incompatible endpoints and renders model-unsupported as a 400', async () => {
  const upstream = vi.fn(() => { throw new Error('unexpected provider call'); });
  const fixture = messagesFixture([messagesUpstream({
    endpoints: { openaiCompletions: {} }, pipelines: { anthropicMessages: generateProvider(upstream) },
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
  const seen: ProviderAnthropicInput[] = [];
  const fixture = messagesFixture([messagesUpstream({
    model: 'claude-target', pipelines: {
      anthropicMessagesCountTokens: countProvider(facts => {
        seen.push(facts);
        return httpReply(200, Bytes.fromUtf8('{"input_tokens":42}'), [['content-type', 'application/json']]);
      }),
    },
  })]);
  const payload = messagesPayload({ model: 'claude-alias' });
  const { response, done } = await fixture.send(payload, { count: true, headers });
  expect(response.status).toBe(200);
  expect(await response.text()).toBe('{"input_tokens":42}');
  expect(seen[0]).toMatchObject({ 'provider.model': { id: 'claude-target' }, 'request.anthropicBeta': beta, 'request.headers': [] });
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
  const seen: ProviderAnthropicInput['request.payload'][] = [];
  const fixture = messagesFixture([
    messagesUpstream({
      upstreamId: 'strip', flags: ['strip-billing-attribution'], pipelines: {
        anthropicMessages: generateProvider(facts => {
          const payload = facts['request.payload'];
          seen.push(payload);
          const [message] = payload.messages;
          const block = Array.isArray(message.content) ? message.content[0] : undefined;
          if (block?.type !== 'text') throw new Error('expected text block');
          expect(() => { block.text = 'mutated by prior provider'; }).toThrow(TypeError);
          return { ...httpReply(503, Bytes.fromUtf8('unavailable')), 'response.modelKey': 'loser', 'response.events': undefined };
        }),
      },
    }),
    messagesUpstream({
      upstreamId: 'preserve', pipelines: {
        anthropicMessages: generateProvider((facts, env) => {
          seen.push(facts['request.payload']);
          return generateReply(env);
        }),
      },
    }),
  ]);
  const { response, done } = await fixture.send(messagesPayload({ system, messages }));
  expect(response.status).toBe(200);
  expect(await done).toMatchObject({ ok: true });
  expect(seen.map(payload => payload.system)).toEqual([[system[1]], system]);
  expect(seen[1]?.messages).toEqual(messages);
  expect(fixture.usage.map(row => row.upstream)).toEqual(['preserve']);
});

test('alias resolution swaps the inbound model id for the target and overlays native rules', async () => {
  const seen: ProviderAnthropicInput[] = [];
  const fixture = messagesFixture([messagesUpstream({
    model: 'claude-opus-4-7', rules: { reasoning: { effort: 'high', budget_tokens: 2048 }, serviceTier: 'fast' },
    pipelines: {
      anthropicMessages: generateProvider((facts, env) => {
        seen.push(facts);
        return generateReply(env);
      }),
    },
  })]);
  const { response, done } = await fixture.send(messagesPayload({ model: 'claude-fast' }));
  expect(response.status).toBe(200);
  expect(await done).toMatchObject({ ok: true });
  expect(fixture.requestedModels).toEqual(['claude-fast']);
  expect(seen[0]).toMatchObject({
    'provider.model': { id: 'claude-opus-4-7' }, 'request.payload': {
      output_config: { effort: 'high' }, thinking: { type: 'enabled', budget_tokens: 2048 }, speed: 'fast',
    },
  });
  expect(seen[0]?.['request.payload']).not.toHaveProperty('model');
});
