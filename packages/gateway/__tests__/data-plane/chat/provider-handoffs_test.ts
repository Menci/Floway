import { expect, test } from 'vitest';

import { emitOpenAIChatCompletions } from '../../../src/data-plane/chat/openai-chat-completions/emit.ts';
import { openaiChatCompletionsWire } from '../../../src/data-plane/chat/openai-chat-completions/wire.ts';
import { prologueFor } from '../../../src/data-plane/pipeline/serve.ts';
import type { StreamOutcome } from '../../../src/data-plane/pipeline/serve.ts';
import { mockChatGatewayCtx } from '../../test-utils/gateway-ctx.ts';
import { isReplayableBody } from '@floway-dev/http';
import { compose, move, run, type Deferred, type Event } from '@floway-dev/pipeline';
import type { SseFrame } from '@floway-dev/protocols/common';
import type { ModelCandidate } from '@floway-dev/provider';
import { createCustomPipelines } from '@floway-dev/provider-custom';
import { stubModelCandidate } from '@floway-dev/test-utils';

const config = { baseUrl: 'https://custom.example', authStyle: 'none' as const, endpoints: {}, ingressHeadersRules: [], modelsFetch: { enabled: false }, models: [] };
const first = { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'wire-model', choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }] };
const usage = { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'wire-model', choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };

const runWire = async (response: Response) => {
  const gateway = mockChatGatewayCtx({ wantsStream: true });
  const base = prologueFor(gateway, { body: { bytes: new Uint8Array(), streamError: null }, headers: [] });
  const plain = stubModelCandidate({ model: { id: 'alias', endpoints: { openaiChatCompletions: {} } }, providerData: 'wire-model' });
  let calls = 0;
  const candidate: ModelCandidate = {
    ...plain,
    provider: { ...plain.provider, pipelines: createCustomPipelines(config) },
    fetcher: async (url, init) => {
      expect(url).toBe('https://custom.example/v1/chat/completions');
      if (!isReplayableBody(init.body)) throw new Error('JSON HTTP content must be replayable');
      calls += 1;
      expect(await new Response(init.body.open()).json()).toMatchObject({ model: 'wire-model', stream: true, messages: [{ role: 'user', content: 'hello' }], stream_options: { include_usage: true } });
      return response;
    },
  };
  const [selector] = base.services.rememberCandidates([candidate]);
  const events: Event[] = [];
  const executed = await run(compose<Record<string, unknown>, Record<string, unknown>>('typedChat', [emitOpenAIChatCompletions, ...openaiChatCompletionsWire('response.chat.openaiChatCompletions.streamedUsage')]), move({
    'ingress.chat.openaiChatCompletions.wantsStream': true,
    'ingress.chat.openaiChatCompletions.wantsUsageChunk': false,
    'ingress.chat.sourceProtocol': 'openaiChatCompletions',
    'ingress.http.headers': [],
    'request.chat.openaiChatCompletions': { model: 'alias', messages: [{ role: 'user', content: 'hello' }] },
    'route.attempt': selector,
  }), {
    ...base.services, gateway,
    recordProtocolFrames: <T>(frames: AsyncIterable<T>) => frames,
    selectAffinity: () => {},
    dump: (event: Event) => { events.push(event); },
  });
  return { executed, events, calls: () => calls };
};

for (const client of ['unread', 'partial', 'complete'] as const) test(`typed provider handoff preserves HTTP 201 and drains one reading after ${client} client output`, async () => {
  const { executed, events, calls } = await runWire(new Response([first, usage].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { status: 201, headers: { 'content-type': 'text/event-stream', 'x-upstream': 'kept' } }));
  expect(executed.facts['response.http.status']).toBe(201);
  expect(executed.facts['response.http.headers']).toContainEqual(['x-upstream', 'kept']);
  const frames = executed.facts['response.chat.openaiChatCompletions.rendered'] as AsyncIterable<SseFrame>;
  if (client === 'partial') {
    const iterator = frames[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.data).toContain('partial');
    await iterator.return?.();
  } else if (client === 'complete') {
    const sent: SseFrame[] = [];
    for await (const frame of frames) sent.push(frame);
    expect(sent).toHaveLength(1);
  }
  await executed.drain();
  const outcome = await (executed.facts['response.chat.openaiChatCompletions.streamedUsage'] as Deferred<StreamOutcome>);
  expect(outcome.failed).toBe(client !== 'complete');
  expect(outcome.billable).toHaveLength(1);
  expect(outcome.billable[0].quantities).toMatchObject({ input_tokens: '10', output_tokens: '5' });
  expect(calls()).toBe(1);
  expect(events).toContainEqual(expect.objectContaining({ type: 'stage.entered', name: 'http' }));
  expect(events).toContainEqual(expect.objectContaining({ type: 'stage.entered', facts: expect.objectContaining({ 'request.provider.payload': expect.objectContaining({ messages: [{ role: 'user', content: 'hello' }] }), 'request.provider.model': expect.objectContaining({ enabledFlags: [] }) }) }));
});

test('an actual upstream quantity-formatting fault rejects produced usage with the original error', async () => {
  const raw = `data: ${JSON.stringify(first)}\n\ndata: {"id":"c1","object":"chat.completion.chunk","model":"wire-model","choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1e999,"total_tokens":1}}\n\ndata: [DONE]\n\n`;
  const { executed, calls } = await runWire(new Response(raw, { headers: { 'content-type': 'text/event-stream' } }));
  const sent: SseFrame[] = [];
  for await (const frame of executed.facts['response.chat.openaiChatCompletions.rendered'] as AsyncIterable<SseFrame>) sent.push(frame);
  const reading = executed.facts['response.chat.openaiChatCompletions.streamedUsage'] as Deferred<StreamOutcome>;
  let original: unknown;
  try { await reading; } catch (error) { original = error; }
  expect(original).toBeInstanceOf(TypeError);
  expect((original as Error).message).toContain('Infinity');
  expect(JSON.parse(sent.at(-1)!.data)).toMatchObject({ error: { name: 'TypeError', message: (original as Error).message } });
  expect(executed.facts['response.usage.billable']).toMatchObject([{ quantities: {} }]);
  expect(calls()).toBe(1);
  let teardown: unknown;
  try { await executed.drain(); } catch (error) { teardown = error; }
  const causes = teardown instanceof AggregateError ? teardown.errors as unknown[] : [teardown];
  expect(causes.length).toBeGreaterThan(0);
  expect(causes.every(error => error === original)).toBe(true);
});
