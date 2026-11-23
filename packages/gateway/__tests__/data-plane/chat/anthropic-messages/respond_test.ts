import { expect, test } from 'vitest';

import { generateReply, messagesFixture, messagesPayload, messagesUpstream } from './fixture.ts';
import { stubEgressPipeline } from '../shared/fixture.ts';
import { jsonResponse } from '@floway-dev/test-utils';

const nestedFailure = () => {
  const cause = new TypeError('nested');
  cause.stack = 'TypeError: nested\n  at nested';
  const failure = new Error('broken', { cause });
  failure.stack = 'Error: broken\n  at render';
  return failure;
};

const diagnostic = {
  name: 'Error', stack: 'Error: broken\n  at render',
  cause: { name: 'TypeError', message: 'nested', stack: 'TypeError: nested\n  at nested' },
};

test('Anthropic Messages SSE render failures preserve transport shape and namespaced diagnostics', async () => {
  const fixture = messagesFixture([messagesUpstream({
    fetcher: async () => generateReply((async function* () { throw nestedFailure(); })()),
  })]);
  const { response, done } = await fixture.send(messagesPayload({ stream: true }));
  expect(response.status).toBe(200);
  const wire = await response.text();
  const data = wire.split('\n').find(line => line.startsWith('data: '));
  expect(wire).toContain('event: error');
  expect(JSON.parse(data!.slice(6))).toEqual({ type: 'error', error: { type: 'api_error', message: 'broken', provider_specific_fields: diagnostic } });
  expect(await done).toMatchObject({ ok: true });
});

test('Anthropic Messages internal HTTP failures preserve transport shape and namespaced diagnostics', async () => {
  const body = { type: 'error', error: { type: 'internal_error', message: 'broken', provider_specific_fields: { ...diagnostic, target_api: 'anthropicMessages' } } };
  const fixture = messagesFixture([messagesUpstream({
    fetcher: async () => jsonResponse(body, 503),
  })]);
  const { response, done } = await fixture.send(messagesPayload());
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual(body);
  expect(await done).toMatchObject({ ok: true });
});

test('Anthropic Messages collecting a broken stream retains the nested error cause in an HTTP 502', async () => {
  const fixture = messagesFixture([messagesUpstream({
    fetcher: async () => generateReply((async function* () { throw nestedFailure(); })()),
  })]);
  const { response, done } = await fixture.send(messagesPayload());
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ type: 'error', error: { type: 'internal_error', message: 'broken', provider_specific_fields: diagnostic } });
  expect(await done).toMatchObject({ ok: true });
});

test('Anthropic Messages lets an egress panic propagate through failover', async () => {
  const failure = nestedFailure();
  const fixture = messagesFixture(undefined, {
    egress: stubEgressPipeline('anthropicMessages', () => { throw failure; }),
  });
  await expect(fixture.send(messagesPayload())).rejects.toBe(failure);
  expect(fixture.events.filter(event => event.k === 'enter' && event.name === 'stubEgress')).toHaveLength(1);
  expect(fixture.usage).toEqual([]);
  expect(fixture.performance).toEqual([]);
});
