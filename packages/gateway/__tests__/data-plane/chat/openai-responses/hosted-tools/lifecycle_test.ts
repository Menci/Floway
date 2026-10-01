import { expect, test } from 'vitest';

import { emitOpenAIResponses } from '../../../../../src/data-plane/chat/openai-responses/emit.ts';
import type { HostedToolRegistration } from '../../../../../src/data-plane/chat/openai-responses/hosted-tools/types.ts';
import { hostedTools } from '../../../../../src/data-plane/chat/openai-responses/hosted-tools.ts';
import { openaiResponsesWire } from '../../../../../src/data-plane/chat/openai-responses/wire.ts';
import { prologueFor, type StreamOutcome } from '../../../../../src/data-plane/pipeline/serve.ts';
import { mockChatGatewayCtx } from '../../../../test-utils/gateway-ctx.ts';
import { isReplayableBody } from '@floway-dev/http';
import { compose, move, run, type Deferred } from '@floway-dev/pipeline';
import type { SseFrame } from '@floway-dev/protocols/common';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesResult, OpenAIResponsesStreamEvent } from '@floway-dev/protocols/openai-responses';
import type { ModelCandidate } from '@floway-dev/provider';
import { createCustomPipelines } from '@floway-dev/provider-custom';
import { stubModelCandidate } from '@floway-dev/test-utils';

const key = 'response.chat.openaiResponses.streamedUsage';
const payload: CanonicalOpenAIResponsesPayload = { model: 'model', input: [], tools: [{ type: 'web_search' }] };
const shell = (status: OpenAIResponsesResult['status'], input: number, output: number): OpenAIResponsesResult => ({ id: 'upstream', object: 'response', model: 'model', output: [], status, error: null, incomplete_details: null, usage: { input_tokens: input, output_tokens: output, total_tokens: input + output } });
const first: OpenAIResponsesStreamEvent[] = [
  { type: 'response.created', response: shell('in_progress', 0, 0) },
  { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'tool', call_id: 'call', name: 'test_search', arguments: '', status: 'in_progress' } },
  { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'tool', call_id: 'call', name: 'test_search', arguments: '{}', status: 'completed' } },
  { type: 'response.completed', response: shell('completed', 3, 2) },
];
const second: OpenAIResponsesStreamEvent[] = [
  { type: 'response.created', response: shell('in_progress', 0, 0) },
  { type: 'response.output_text.delta', output_index: 0, item_id: 'message', content_index: 0, delta: 'partial' },
  { type: 'response.completed', response: shell('completed', 4, 3) },
];

for (const client of ['unread', 'partial-before-tool', 'partial-second', 'complete'] as const) test(`hosted ReAct settles actual model calls after ${client} output`, async () => {
  let calls = 0;
  let tools = 0;
  const registration: HostedToolRegistration = () => ({
    type: 'active', baseToolName: 'test_search', hosted: {
      hostedTypes: ['web_search'],
      canonicalize: tool => tool.type === 'web_search' ? tool : undefined,
      buildFunctionTool: (_tool, name) => ({ type: 'function', name, description: 'Search', parameters: { type: 'object' }, strict: false }),
      dispatcher: () => {
        tools += 1;
        return [{ id: 'search-item', startItem: { type: 'web_search_call', status: 'in_progress' }, startEvents: [], async *run() { return { item: { type: 'web_search_call', status: 'completed' }, endEvents: [] }; } }];
      },
    },
  });
  const gateway = mockChatGatewayCtx({ wantsStream: true });
  const base = prologueFor(gateway, { body: { bytes: new Uint8Array(), streamError: null }, headers: [] });
  const plain = stubModelCandidate();
  const candidate: ModelCandidate = {
    ...plain,
    provider: { ...plain.provider, pipelines: createCustomPipelines({ baseUrl: 'https://custom.example', authStyle: 'none', endpoints: {}, ingressHeadersRules: [], modelsFetch: { enabled: false }, models: [] }) },
    fetcher: async (_url, init) => {
      if (!isReplayableBody(init.body)) throw new Error('Expected JSON HTTP request');
      expect(await new Response(init.body.open()).json()).toMatchObject({ stream: true });
      calls += 1;
      return new Response((calls === 1 ? first : second).map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
    },
  };
  const [selector] = base.services.rememberCandidates([candidate]);
  const executed = await run(compose<Record<string, unknown>, Record<string, unknown>>('hostedLifecycle', [
    emitOpenAIResponses('sse'), hostedTools([registration], { streamedUsage: key, targetOf: () => 'openaiResponses' }), ...openaiResponsesWire(key),
  ]), move({ 'request.chat.openaiResponses': payload, 'route.attempt': selector, 'ingress.http.headers': [], 'ingress.chat.sourceProtocol': 'openaiResponses', 'ingress.chat.openaiResponses.wantsStream': true, 'serve.usage.prior': [] }), {
    ...base.services, gateway, recordProtocolFrames: <T>(frames: AsyncIterable<T>) => frames, selectAffinity: () => {},
  });
  const rendered = executed.facts['response.chat.openaiResponses.rendered'] as AsyncIterable<SseFrame>;
  if (client !== 'unread') {
    const iterator = rendered[Symbol.asyncIterator]();
    if (client === 'complete') {
      let step = await iterator.next();
      while (!step.done) step = await iterator.next();
    } else if (client === 'partial-before-tool') await iterator.next();
    else {
      let step = await iterator.next();
      while (!step.done && !(calls === 2 && step.value.data.includes('partial'))) step = await iterator.next();
      expect(step.done).toBe(false);
    }
    if (client !== 'complete') await iterator.return?.();
  }
  await executed.drain();
  const outcome = await (executed.facts[key] as Deferred<StreamOutcome>);
  const repeated = client === 'partial-second' || client === 'complete';
  expect(calls).toBe(repeated ? 2 : 1);
  expect(tools).toBe(repeated ? 1 : 0);
  expect(outcome.failed).toBe(client !== 'complete');
  expect(outcome.billable.map(entity => [entity.quantities.input_tokens, entity.quantities.output_tokens])).toEqual(repeated ? [['3', '2'], ['4', '3']] : [['3', '2']]);
});
