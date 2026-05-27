import { test } from 'vitest';

import { targetProviderResultToFrames } from './emit.ts';
import { assertEquals, assertStringIncludes } from '../../../test-assert.ts';
import { stubProvider, stubUpstreamModel } from '../../../test-helpers.ts';
import type { Invocation, RequestContext } from '../interceptors.ts';

const baseInvocation = (): Invocation<{ model: string; stream?: boolean }> => ({
  sourceApi: 'messages',
  targetApi: 'messages',
  model: 'claude-test',
  upstream: 'copilot:1',
  payload: { model: 'claude-test', stream: true },
  provider: stubProvider(),
  upstreamModel: stubUpstreamModel(),
  enabledFlags: new Set<string>(),
  headers: {},
});

const baseRequest = (): RequestContext => ({
  requestStartedAt: 0,
  apiKeyId: 'key_a',
  clientStream: true,
  runtimeLocation: 'SJC',
});

const testTelemetryModelIdentity = {
  model: 'claude-test',
  upstream: 'copilot:1',
  modelKey: 'claude-test-raw', cost: null,
};

test('targetProviderResultToFrames returns 502 with diagnostic context when upstream replies with non-SSE 200', async () => {
  const response = new Response(JSON.stringify({ id: 'msg_json_only' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

  const result = await targetProviderResultToFrames(baseInvocation(), baseRequest(), 'messages', { response, modelKey: 'claude-test-raw' }, testTelemetryModelIdentity, performance.now());

  assertEquals(result.type, 'internal-error');
  if (result.type !== 'internal-error') throw new Error('expected internal-error');
  assertEquals(result.status, 502);
  assertStringIncludes(result.error.message, '200');
  assertStringIncludes(result.error.message, 'application/json');
  assertStringIncludes(result.error.message, 'stream is required');
});

test('targetProviderResultToFrames accepts SSE 200 responses', async () => {
  const response = new Response('data: {"type":"message_stop"}\n\n', {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  });

  const result = await targetProviderResultToFrames(baseInvocation(), baseRequest(), 'messages', { response, modelKey: 'claude-test-raw' }, testTelemetryModelIdentity, performance.now());

  assertEquals(result.type, 'events');
});
