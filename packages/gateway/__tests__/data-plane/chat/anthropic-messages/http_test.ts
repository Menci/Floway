import { expect, test, vi } from 'vitest';

import { countProvider, defaultFrames, generateProvider, generateReply, httpReply, messagesFixture, messagesPayload, messagesUpstream } from './fixture.ts';
import { Bytes } from '@floway-dev/pipeline';

test('POST /v1/messages returns a single JSON body when stream is omitted', async () => {
  const fixture = messagesFixture();
  const { response, done } = await fixture.send(messagesPayload());
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('application/json');
  expect(await response.json()).toMatchObject({ role: 'assistant' });
  expect(await done).toMatchObject({ ok: true });
  expect(fixture.usage).toHaveLength(1);
});

test('POST /v1/messages answers the Claude Code model-validation probe without an upstream call or a billable call', async () => {
  const upstream = vi.fn(() => { throw new Error('the probe reached the upstream'); });
  const fixture = messagesFixture([messagesUpstream({ pipelines: { anthropicMessages: generateProvider(upstream) } })]);
  const { response, done } = await fixture.send(messagesPayload({
    max_tokens: 1, system: [{ type: 'text', text: 'You are Claude Code.' }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi', cache_control: { type: 'ephemeral' } }] }],
    metadata: { user_id: 'user_0_account__session_0' },
  }), { headers: { 'user-agent': 'claude-cli/2.1.226 (external, cli)' } });

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ model: 'test-model', stop_reason: 'max_tokens', usage: { input_tokens: 0, output_tokens: 0 } });
  expect(upstream).not.toHaveBeenCalled();
  expect(await done).toMatchObject({ ok: true });
  expect(fixture.usage).toEqual([]);
});

test.each(['anthropic_beta', 'betas'])('POST /v1/messages rejects body %s with a 400 before routing', async param => {
  const fixture = messagesFixture([]);
  const { response, done } = await fixture.send({ ...messagesPayload(), [param]: ['example'] });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { param, type: 'invalid_request_error', message: expect.stringContaining('anthropic-beta HTTP header') } });
  expect(fixture.requestedModels).toEqual([]);
  expect(await done).toMatchObject({ ok: true });
});

test('POST /v1/messages/count_tokens forwards an upstream rate limit and retry hint unchanged', async () => {
  const body = '{"error":{"type":"rate_limit_error","message":"wait"}}';
  const upstream = vi.fn(() => httpReply(429, Bytes.fromUtf8(body), [
    ['content-type', 'application/json'], ['retry-after', '17'], ['request-id', 'req-count'], ['set-cookie', 'private=1'],
  ]));
  const fixture = messagesFixture([messagesUpstream({ pipelines: { anthropicMessagesCountTokens: countProvider(upstream) } })]);
  const { facts, response, done } = await fixture.send({ model: 'test-model', messages: [{ role: 'user', content: 'hello' }] }, { count: true });
  expect(upstream).toHaveBeenCalledOnce();
  expect(response.status).toBe(429);
  expect(response.headers.get('retry-after')).toBe('17');
  expect(response.headers.get('request-id')).toBe('req-count');
  expect(response.headers.get('set-cookie')).toBeNull();
  expect(await response.text()).toBe(body);
  expect(await done).toMatchObject({ ok: true });
  expect(await facts['response.settlement'].promise).toMatchObject({ outcome: 'upstream-error' });
  expect(fixture.usage).toEqual([]);
});

test('POST /v1/messages does not switch upstreams after the response stream opens and breaks', async () => {
  const fixture = messagesFixture([
    messagesUpstream({
      upstreamId: 'first', pipelines: {
        anthropicMessages: generateProvider((_facts, env) => generateReply(env, async function* () {
          for await (const frame of defaultFrames()) {
            yield frame;
            throw new Error('connection reset after message_start');
          }
        })),
      },
    }),
    messagesUpstream({ upstreamId: 'second', pipelines: { anthropicMessages: generateProvider(() => { throw new Error('unexpected failover'); }) } }),
  ]);
  const { response, done } = await fixture.send(messagesPayload({ stream: true }));
  const wire = await response.text();
  expect(response.status).toBe(200);
  expect(wire).toContain('event: message_start');
  expect(wire).toContain('event: error');
  expect(wire).toContain('connection reset after message_start');
  await done;
  expect(fixture.usage).toHaveLength(1);
});
