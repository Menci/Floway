import { expect, test } from 'vitest';

import { generateProvider, generateReply, httpReply, messagesFixture, messagesPayload, messagesUpstream } from './fixture.ts';
import { Bytes } from '@floway-dev/pipeline';

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
    pipelines: {
      anthropicMessages: generateProvider((_facts, env) =>
        generateReply(env, async function* () { throw nestedFailure(); })),
    },
  })]);
  const { response, done } = await fixture.send(messagesPayload({ stream: true }));
  expect(response.status).toBe(200);
  const wire = await response.text();
  const data = wire.split('\n').find(line => line.startsWith('data: '));
  expect(wire).toContain('event: error');
  expect(JSON.parse(data!.slice(6))).toEqual({ type: 'error', error: { type: 'api_error', message: 'broken', provider_specific_fields: diagnostic } });
  await done;
});

test('Anthropic Messages internal HTTP failures preserve transport shape and namespaced diagnostics', async () => {
  const body = { type: 'error', error: { type: 'internal_error', message: 'broken', provider_specific_fields: { ...diagnostic, target_api: 'anthropicMessages' } } };
  const fixture = messagesFixture([messagesUpstream({
    pipelines: {
      anthropicMessages: generateProvider(() => ({
        ...httpReply(503, Bytes.fromUtf8(JSON.stringify(body)), [['content-type', 'application/json']]),
        'response.modelKey': 'test-model-key', 'response.events': undefined,
      })),
    },
  })]);
  const { response, done } = await fixture.send(messagesPayload());
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual(body);
  expect(await done).toMatchObject({ ok: true });
});

test('Anthropic Messages collecting a broken stream retains the nested error cause in an HTTP 502', async () => {
  const fixture = messagesFixture([messagesUpstream({
    pipelines: {
      anthropicMessages: generateProvider((_facts, env) =>
        generateReply(env, async function* () { throw nestedFailure(); })),
    },
  })]);
  const { response, done } = await fixture.send(messagesPayload());
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ type: 'error', error: { type: 'internal_error', message: 'broken', provider_specific_fields: diagnostic } });
  await done;
});
