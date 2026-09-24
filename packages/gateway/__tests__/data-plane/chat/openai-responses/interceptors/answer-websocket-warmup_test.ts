import { test } from 'vitest';

import { answerWebSocketWarmup } from '../../../../../src/data-plane/chat/openai-responses/interceptors/answer-websocket-warmup.ts';
import type { OpenAIResponsesInvocation } from '../../../../../src/data-plane/chat/openai-responses/interceptors/types.ts';
import { mockChatGatewayCtx } from '../../../../test-utils/gateway-ctx.ts';
import { doneFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesStreamEvent } from '@floway-dev/protocols/openai-responses';
import { eventResult } from '@floway-dev/provider';
import { assertEquals, stubModelCandidate, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const stubCtx = mockChatGatewayCtx();

const invocation = (payload: CanonicalOpenAIResponsesPayload): OpenAIResponsesInvocation => ({
  payload,
  candidate: stubModelCandidate(),
  targetApi: 'openaiResponses',
  headers: new Headers(),
  action: 'generate',
});

const payload = (generate?: boolean): CanonicalOpenAIResponsesPayload => ({
  model: 'gpt-test',
  input: [{ type: 'message', role: 'developer', content: 'Base instructions' }],
  ...(generate === undefined ? {} : { generate }),
});

test('answers a generate:false prewarm with an empty completed response and no upstream call', async () => {
  let upstreamCalls = 0;
  const result = await answerWebSocketWarmup(invocation(payload(false)), stubCtx, () => {
    upstreamCalls++;
    return Promise.resolve(eventResult((async function* () { yield doneFrame(); })(), testTelemetryModelIdentity));
  });

  assertEquals(upstreamCalls, 0);
  if (result.type !== 'events') throw new Error(`expected events, got ${result.type}`);
  const frames: ProtocolFrame<OpenAIResponsesStreamEvent>[] = [];
  for await (const frame of result.events) frames.push(frame);
  const types = frames.map(frame => frame.type === 'event' ? frame.event.type : frame.type);
  assertEquals(types, ['response.created', 'response.in_progress', 'response.completed', 'done']);
  const terminal = frames[2];
  if (terminal?.type !== 'event' || terminal.event.type !== 'response.completed') throw new Error('expected a completed terminal');
  assertEquals(terminal.event.response.status, 'completed');
  assertEquals(terminal.event.response.output, []);
  assertEquals(terminal.event.response.model, 'gpt-test');
  assertEquals(terminal.event.response.usage, { input_tokens: 0, output_tokens: 0, total_tokens: 0 });
});

for (const generate of [undefined, true]) {
  test(`passes a generate:${generate} request through to the upstream`, async () => {
    let upstreamCalls = 0;
    const upstream = eventResult((async function* () { yield doneFrame(); })(), testTelemetryModelIdentity);
    const result = await answerWebSocketWarmup(invocation(payload(generate)), stubCtx, () => {
      upstreamCalls++;
      return Promise.resolve(upstream);
    });

    assertEquals(upstreamCalls, 1);
    assertEquals(result, upstream);
  });
}
