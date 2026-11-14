import { Hono } from 'hono';
import { expect, test } from 'vitest';

import { emitOpenAIChatCompletions } from '../../../src/data-plane/chat/openai-chat-completions/emit.ts';
import { serializeClientJson } from '../../../src/data-plane/pipeline/serialize-client-json.ts';
import { prologueFor, serveThrough } from '../../../src/data-plane/pipeline/serve.ts';
import { writeSettlement } from '../../../src/data-plane/pipeline/settlement.ts';
import { initRepo } from '../../../src/repo/index.ts';
import { InMemoryRepo } from '../../repo/memory.ts';
import { flushBackground, trackBackground } from '../../test-utils/background-tracker.ts';
import { mockChatGatewayCtx } from '../../test-utils/gateway-ctx.ts';
import { compose, defineStage, move } from '@floway-dev/pipeline';
import { testTelemetryModelIdentity } from '@floway-dev/test-utils';

test('a client JSON formatting fault is inside the run settlement boundary', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const now = performance.now();
  const gateway = mockChatGatewayCtx({
    backgroundScheduler: trackBackground, attempt: {
      timing: { upstreamCallStartedAt: now - 10, firstOutputTokenAt: now - 5 },
      telemetry: { keyId: 'json-key', model: 'model', upstream: 'upstream', operation: 'chat', runtimeLocation: 'TEST' },
    },
  });
  const ending = defineStage<Record<string, unknown>, Record<string, unknown>>({
    name: 'scriptedValue',
    return: { provides: ['response.chat.openaiChatCompletions', 'response.chat.openaiChatCompletions.streamedUsage', 'response.http.headers', 'response.http.status', 'response.usage.billable'] },
    execute: async facts => move({
      ...facts,
      'response.chat.openaiChatCompletions': { kind: 'value', body: { id: 'completion', extension: 1n } },
      'response.chat.openaiChatCompletions.streamedUsage': null,
      'response.http.headers': [], 'response.http.status': 200,
      'response.usage.billable': [{ identity: testTelemetryModelIdentity, quantities: { input_tokens: '3', output_tokens: '2' } }],
    }),
  });
  const pipeline = compose<Record<string, unknown>, Record<string, unknown> & { 'response.http.status': number; 'response.http.headers': readonly (readonly [string, string])[] }>('clientJson', [
    writeSettlement(facts => Number(facts['response.http.status']) >= 400, 'response.chat.openaiChatCompletions.streamedUsage'),
    serializeClientJson('response.chat.openaiChatCompletions.rendered'), emitOpenAIChatCompletions, ending,
  ]);
  const app = new Hono();
  app.post('/v1/chat/completions', c => serveThrough(c, prologueFor(gateway, { body: { bytes: new Uint8Array(), streamError: null }, headers: [] }), pipeline,
    move({ 'ingress.chat.openaiChatCompletions.wantsStream': false, 'ingress.chat.openaiChatCompletions.wantsUsageChunk': false }),
    facts => ({ body: facts['response.http.jsonBody'] as Uint8Array<ArrayBuffer>, contentType: 'application/json' })));
  const response = await app.request('/v1/chat/completions', { method: 'POST' });
  expect(response.status).toBe(500);
  expect(await response.json()).toMatchObject({ error: { name: 'TypeError', message: 'Do not know how to serialize a BigInt' } });
  await flushBackground();
  expect(await repo.usage.listAll()).toMatchObject([{ requests: 1 }]);
  expect(await repo.performance.listAll()).toMatchObject([{ requests: 1, errorsWithOutput: 1, errorsNoOutput: 0 }]);
});
