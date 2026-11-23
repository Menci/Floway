import { expect, test, vi } from 'vitest';

import { defaultFrames, generateReply, messagesFixture, messagesPayload, messagesUpstream } from './fixture.ts';
import { initDumpBroker, initDumpStore } from '../../../../src/dump/registry.ts';
import { initRepo } from '../../../../src/repo/index.ts';
import { installDumpStubs } from '../../../dump/test-fixtures.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { UpstreamTransportError } from '@floway-dev/http';

test('POST /v1/messages returns a single JSON body when stream is omitted', async () => {
  initRepo(new InMemoryRepo());
  const dump = installDumpStubs(initDumpStore, initDumpBroker);
  const fixture = messagesFixture(undefined, { dumpRetentionSeconds: 3600 });
  const { response, done } = await fixture.send(messagesPayload());
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('application/json');
  expect(await response.json()).toMatchObject({ role: 'assistant' });
  expect(await done).toMatchObject({ ok: true });
  expect(fixture.usage).toMatchObject([{ upstream: 'test-upstream', model: 'test-model', requests: 1 }]);
  expect(fixture.performance).toHaveLength(1);
  expect(dump.stored[0]?.meta).toMatchObject({
    status: 200, model: 'test-model', targetApi: 'anthropicMessages', inputTokens: 3, outputTokens: 5, error: null,
  });
});

test('POST /v1/messages answers the Claude Code model-validation probe without an upstream call or a billable call', async () => {
  const upstream = vi.fn(async () => { throw new Error('the probe reached the upstream'); });
  const fixture = messagesFixture([messagesUpstream({ fetcher: upstream })]);
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
  expect(fixture.performance).toEqual([]);
});

test.each(['anthropic_beta', 'betas'])('POST /v1/messages rejects body %s with a 400 before routing', async param => {
  const fixture = messagesFixture([]);
  const { response, done } = await fixture.send({ ...messagesPayload(), [param]: ['example'] });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { param, type: 'invalid_request_error', message: expect.stringContaining('anthropic-beta HTTP header') } });
  expect(fixture.requestedModels).toEqual([]);
  expect(await done).toMatchObject({ ok: true });
});

test.each([false, true])('interrupted Messages uploads return the Anthropic transport error before routing (count=%s)', async count => {
  const fixture = messagesFixture([]);
  const uploadError = { name: 'AbortError', message: 'client disconnected during upload', stack: 'AbortError: client disconnected during upload' };
  const { response, done } = await fixture.send(undefined, { count, uploadError });

  expect(response.status).toBe(502);
  expect(response.headers.get('content-type')).toBe('application/json');
  expect(await response.json()).toEqual({
    type: 'error',
    error: {
      type: 'internal_error',
      message: uploadError.message,
      provider_specific_fields: { name: uploadError.name, stack: uploadError.stack },
    },
  });
  expect(await done).toMatchObject({ ok: true });
  expect(fixture.requestedModels).toEqual([]);
  const parse = fixture.events.find(event => event.k === 'enter' && event.name === 'parsePayload');
  if (parse?.k !== 'enter') throw new Error('Missing parsePayload trace entry');
  expect(parse).toMatchObject({ facts: { 'request.http': { body: { kind: 'upload-error', error: uploadError } } } });
  expect(fixture.events).toContainEqual(
    expect.objectContaining({ k: 'leave', stageId: parse.stageId, facts: expect.objectContaining({ 'response.http': expect.objectContaining({ status: 502 }) }) }),
  );
});

test.each([false, true])('invalid Messages JSON returns a 400 before routing (count=%s)', async count => {
  const fixture = messagesFixture([]);
  const { response, done } = await fixture.send(undefined, { count, rawBody: '{"truncated":' });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { type: 'invalid_request_error', message: expect.stringContaining('valid JSON') } });
  expect(fixture.requestedModels).toEqual([]);
  expect(await done).toMatchObject({ ok: true });
});

test('POST /v1/messages/count_tokens forwards an upstream rate limit and retry hint unchanged', async () => {
  const body = '{"error":{"type":"rate_limit_error","message":"wait"}}';
  const upstream = vi.fn(async () => new Response(body, {
    status: 429, headers: { 'content-type': 'application/json', 'retry-after': '17', 'request-id': 'req-count', 'set-cookie': 'private=1' },
  }));
  const fixture = messagesFixture([messagesUpstream({ fetcher: upstream })]);
  const { facts, response, done } = await fixture.send({ model: 'test-model', messages: [{ role: 'user', content: 'hello' }] }, { count: true });
  expect(upstream).toHaveBeenCalledOnce();
  expect(response.status).toBe(429);
  expect(response.headers.get('retry-after')).toBe('17');
  expect(response.headers.get('request-id')).toBe('req-count');
  expect(response.headers.get('set-cookie')).toBeNull();
  expect(await response.text()).toBe(body);
  expect(await done).toMatchObject({ ok: true });
  expect(await facts['response.render'].promise).toEqual({ kind: 'completed' });
  expect(facts['response.http'].exchange).toBe('upstream');
  expect(fixture.usage).toEqual([]);
  expect(fixture.performance).toEqual([]);
});

test('POST /v1/messages/count_tokens renders upstream text errors as JSON', async () => {
  const fixture = messagesFixture([messagesUpstream({
    fetcher: async () => new Response('upstream offline', { status: 503, headers: { 'retry-after': '5' } }),
  })]);
  const { response, done } = await fixture.send(messagesPayload(), { count: true });
  expect(response.status).toBe(503);
  expect(response.headers.get('content-type')).toBe('application/json');
  expect(response.headers.get('retry-after')).toBe('5');
  expect(await response.json()).toMatchObject({ error: { message: 'upstream offline' } });
  expect(await done).toMatchObject({ ok: true });
});

test.each([false, true])('upstream Messages connection failure returns an Anthropic 502 (count=%s)', async count => {
  const fixture = messagesFixture([messagesUpstream({
    fetcher: async () => { throw new UpstreamTransportError(new TypeError('connection refused')); },
  })]);
  const { response, done } = await fixture.send(messagesPayload(), { count });
  expect(response.status).toBe(502);
  expect(response.headers.get('content-type')).toBe('application/json');
  expect(await response.json()).toMatchObject({
    type: 'error',
    error: {
      type: 'internal_error', message: 'connection refused',
      provider_specific_fields: { name: 'UpstreamTransportError', cause: { name: 'TypeError', message: 'connection refused' } },
    },
  });
  expect(await done).toMatchObject({ ok: true });
  expect(fixture.usage).toEqual([]);
  expect(fixture.performance).toHaveLength(count ? 0 : 1);
});

test('POST /v1/messages does not switch upstreams after the response stream opens and breaks', async () => {
  const next = vi.fn(async () => { throw new Error('unexpected failover'); });
  const fixture = messagesFixture([
    messagesUpstream({
      upstreamId: 'first',
      fetcher: async () => generateReply((async function* () {
        for await (const frame of defaultFrames()) {
          yield frame;
          throw new Error('connection reset after message_start');
        }
      })()),
    }),
    messagesUpstream({ upstreamId: 'second', fetcher: next }),
  ]);
  const { response, done } = await fixture.send(messagesPayload({ stream: true }));
  const wire = await response.text();
  expect(response.status).toBe(200);
  expect(wire).toContain('event: message_start');
  expect(wire).toContain('event: error');
  expect(wire).toContain('connection reset after message_start');
  expect(await done).toMatchObject({ ok: true });
  expect(next).not.toHaveBeenCalled();
  expect(fixture.usage).toHaveLength(1);
  expect(fixture.performance).toHaveLength(1);
});
