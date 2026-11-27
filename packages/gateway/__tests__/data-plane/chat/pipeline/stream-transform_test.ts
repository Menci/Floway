import { expect, test } from 'vitest';

import { serializeAnthropicMessagesItems } from '../../../../src/data-plane/chat/anthropic-messages/pipeline/serialize-stream-items.ts';
import { serializeOpenAIResponsesItems } from '../../../../src/data-plane/chat/openai-responses/pipeline/serialize-stream-items.ts';
import type { ChatRequestFacts, ChatResponseFacts } from '../../../../src/data-plane/chat/pipeline/facts.ts';
import { candidateFor, hostFor } from '../../pipeline/fixtures.ts';
import { asEntry, factSpace, run, type Result } from '@floway-dev/pipeline';
import type { AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import type { FlagId, ProtocolStreamError } from '@floway-dev/upstream';

const { compose, defineStage } = factSpace<ChatRequestFacts, ChatResponseFacts>();
type AnthropicEvent = AnthropicMessagesStreamEventEx;
type AnthropicItem = Result<AnthropicEvent, ProtocolStreamError>;

const start = (index: number): AnthropicEvent => ({
  type: 'content_block_start', index, content_block: { type: 'text', text: '', citations: null },
});
const delta = (index: number, text: string): AnthropicEvent => ({
  type: 'content_block_delta', index, delta: { type: 'text_delta', text },
});
const stop = (index: number): AnthropicEvent => ({ type: 'content_block_stop', index });
const value = <Event>(event: Event): Result<Event, ProtocolStreamError> => ({ ok: true, value: event });
const events = async function* <Event>(frames: readonly Event[]): AsyncGenerator<Result<Event, ProtocolStreamError>> {
  for (const event of frames) yield value(event);
};

const anthropicStream = async (
  source: AsyncGenerator<AnthropicItem, void>,
  enabledFlags: readonly FlagId[] = ['serialize-stream-items'],
  userAgent = '',
) => {
  const ending = defineStage({
    name: 'stream-fixture.anthropic',
    request: { needs: [] },
    return: { provides: ['anthropicMessages'] },
    async execute(_facts, scope) {
      return { anthropicMessages: { kind: 'stream', stream: scope.createStream(() => source) } };
    },
  });
  const entry = asEntry(compose('anthropic-stream-compatibility', {
    entry: ['http', 'model'],
    exit: ['anthropicMessages'],
    stages: [serializeAnthropicMessagesItems],
    ending,
  }));
  const host = hostFor({});
  const running = run(entry, {
    http: { url: 'https://floway.test/v1/messages', method: 'POST', headers: [['user-agent', userAgent]], body: null },
    model: { ...candidateFor('stream').model, enabledFlags },
  }, host.options);
  const answer = await running.result;
  if (answer.anthropicMessages.kind !== 'stream') throw new TypeError('Expected an Anthropic stream');
  return {
    cursor: running.read(answer.anthropicMessages.stream),
    async settle() {
      host.controller.abort();
      running.discard(answer);
      await host.settle();
      expect(host.errors).toEqual([]);
    },
  };
};

test.each([
  { userAgent: 'custom/1 ai-sdk-anthropic/4.0.71 extra', order: [0, 0, 1, 1] },
  { userAgent: 'Anthropic/JS 0.131.0', order: [0, 0, 1, 1] },
  { userAgent: 'ai-sdk-anthropic/4.0.710', order: [0, 1, 0, 1] },
])('uses token-bounded SDK matching for Anthropic block serialization ($userAgent)', async ({ userAgent, order }) => {
  const stream = await anthropicStream(events([start(0), start(1), stop(0), stop(1)]), [], userAgent);
  const output = await Array.fromAsync(stream.cursor);
  expect(output.map(item => item.ok && 'index' in item.value ? item.value.index : null)).toEqual(order);
  await stream.settle();
});

test('keeps current Anthropic output live and replays blocks queued behind it', async () => {
  const gate = Promise.withResolvers<void>();
  const thinking: AnthropicEvent = {
    type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' },
  };
  const signature: AnthropicEvent = {
    type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signed' },
  };
  const sidecar: AnthropicEvent = {
    type: 'content_block_start', index: 2, content_block: { type: 'redacted_thinking', data: 'sidecar' },
  };
  const stream = await anthropicStream((async function* () {
    for (const event of [thinking, start(1), sidecar, delta(1, 'answer'), stop(1), signature]) yield value(event);
    await gate.promise;
    yield value(stop(0));
    yield value(stop(2));
  })());
  expect((await stream.cursor.next()).value).toEqual(value(thinking));
  expect((await stream.cursor.next()).value).toEqual(value(signature));
  gate.resolve();
  expect(await Array.fromAsync(stream.cursor)).toEqual(
    [stop(0), start(1), delta(1, 'answer'), stop(1), sidecar, stop(2)].map(value),
  );
  await stream.settle();
});

test('drops queued blocks on an upstream error and preserves the original cause', async () => {
  const cause = new Error('upstream failed');
  const failure: ProtocolStreamError = { kind: 'transport', cause };
  const stream = await anthropicStream((async function* () {
    yield value(start(0));
    yield value(start(1));
    yield { ok: false, error: failure };
  })());
  const output = await Array.fromAsync(stream.cursor);
  expect(output).toEqual([value(start(0)), { ok: false, error: failure }]);
  expect(output[1]?.ok === false && output[1].error.cause).toBe(cause);
  await stream.settle();
});

test('propagates a stream panic and rejects native completion with queued blocks', async () => {
  const panic = new Error('upstream panic');
  const broken = await anthropicStream((async function* () {
    yield value(start(0));
    yield value(start(1));
    throw panic;
  })());
  await expect(Array.fromAsync(broken.cursor)).rejects.toBe(panic);
  await broken.settle();

  const incomplete = await anthropicStream(events([start(0), start(1)]));
  await expect(Array.fromAsync(incomplete.cursor)).rejects.toThrow('active item never closed');
  await incomplete.settle();
});

test('reorders Responses item lifecycles and assigns sequence numbers in delivery order', async () => {
  const fixture = (type: string, output_index: number, sequence_number: number): OpenAIResponsesStreamEventEx =>
    ({ type, output_index, sequence_number } as OpenAIResponsesStreamEventEx);
  const source = [
    fixture('response.output_item.added', 0, 0),
    fixture('response.output_item.added', 1, 1),
    fixture('response.output_text.delta', 1, 2),
    fixture('response.function_call_arguments.delta', 0, 3),
    fixture('response.output_item.done', 0, 4),
    fixture('response.output_item.done', 1, 5),
  ];
  const ending = defineStage({
    name: 'stream-fixture.responses',
    request: { needs: [] },
    return: { provides: ['openaiResponses'] },
    async execute(_facts, scope) {
      return { openaiResponses: { kind: 'stream', stream: scope.createStream(() => events(source)) } };
    },
  });
  const entry = asEntry(compose('responses-stream-compatibility', {
    entry: ['model'], exit: ['openaiResponses'], stages: [serializeOpenAIResponsesItems], ending,
  }));
  const host = hostFor({});
  const running = run(entry, { model: { ...candidateFor('stream').model, enabledFlags: ['serialize-stream-items'] } }, host.options);
  const answer = await running.result;
  if (answer.openaiResponses.kind !== 'stream') throw new TypeError('Expected a Responses stream');
  const output = await Array.fromAsync(running.read(answer.openaiResponses.stream));
  expect(output.map(item => item.ok && item.value.type)).toEqual([
    'response.output_item.added', 'response.function_call_arguments.delta', 'response.output_item.done',
    'response.output_item.added', 'response.output_text.delta', 'response.output_item.done',
  ]);
  expect(output.map(item => item.ok && item.value.sequence_number)).toEqual([0, 1, 2, 3, 4, 5]);
  expect(source[1]?.sequence_number).toBe(1);
  host.controller.abort();
  running.discard(answer);
  await host.settle();
  expect(host.errors).toEqual([]);
});
