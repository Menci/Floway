import { expect, test } from 'vitest';

import { serializeAnthropicMessagesStream, serializeOpenAIResponsesStream, shouldSerializeStreamItems } from '../../../../../src/data-plane/chat/shared/stream-compatibility/index.ts';
import type { AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import type { FlagId } from '@floway-dev/provider';

const frames = async function* <T>(values: ProtocolFrame<T>[]) { yield* values; };
const collect = async <T>(source: AsyncIterable<T>): Promise<T[]> => { const output: T[] = []; for await (const value of source) output.push(value); return output; };
const start = (index: number) => eventFrame({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } } as AnthropicMessagesStreamEventEx);
const delta = (index: number, text: string) => eventFrame({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } } as AnthropicMessagesStreamEventEx);
const stop = (index: number) => eventFrame({ type: 'content_block_stop', index } as AnthropicMessagesStreamEventEx);

test('disabled mode returns the original iterable and automatic UA handling never changes the flag set', () => {
  const source = frames([start(0), start(1), stop(0), stop(1)]);
  expect(serializeAnthropicMessagesStream(source, false)).toBe(source);
  const flags = new Set<FlagId>();
  for (const ua of ['ai-sdk-anthropic/4.0.71', 'custom/1 ai-sdk-anthropic/4.0.71 extra', 'Anthropic/JS 0.131.0']) expect(shouldSerializeStreamItems(flags, 'anthropicMessages', ua)).toBe(true);
  for (const ua of [null, 'ai-sdk-anthropic/4.0.710', 'ai-sdk-anthropic/4.0.72', 'Anthropic/Python 0.131.0', 'unknown']) expect(shouldSerializeStreamItems(flags, 'anthropicMessages', ua)).toBe(false);
  expect(shouldSerializeStreamItems(flags, 'openaiResponses', 'ai-sdk-anthropic/4.0.71')).toBe(false);
  expect(flags.size).toBe(0);
  expect(shouldSerializeStreamItems(new Set(['serialize-stream-items']), 'openaiResponses', null)).toBe(true);
});

test('current-owner data remains live while later owners wait, then buffered events replay recursively', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = start(0);
  const second = start(1);
  const third = start(2);
  const firstDelta = delta(0, 'A');
  const source = (async function* () {
    yield first; yield second; yield third; yield delta(1, 'B'); yield stop(1);
    yield firstDelta; await gate; yield stop(0); yield delta(2, 'C'); yield stop(2);
  })();
  const ordered = serializeAnthropicMessagesStream(source, true)[Symbol.asyncIterator]();
  expect((await ordered.next()).value).toBe(first);
  expect((await ordered.next()).value).toBe(firstDelta);
  const pending = ordered.next();
  release();
  expect((await pending).value).toEqual(stop(0));
  const rest = await collect({ [Symbol.asyncIterator]: () => ordered });
  expect(rest).toEqual([second, delta(1, 'B'), stop(1), third, delta(2, 'C'), stop(2)]);
});

test('late thinking signature and stop target their original block before the following text begins', async () => {
  const thinking = eventFrame({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } as AnthropicMessagesStreamEventEx);
  const signature = eventFrame({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signed' } } as AnthropicMessagesStreamEventEx);
  const source = [thinking, start(1), delta(1, 'answer'), signature, stop(0), stop(1)];
  expect(await collect(serializeAnthropicMessagesStream(frames(source), true))).toEqual([thinking, signature, stop(0), start(1), delta(1, 'answer'), stop(1)]);
});

test('errors discard withheld items and upstream failures retain the original error object', async () => {
  const error = eventFrame({ type: 'error', error: { type: 'overloaded_error', message: 'failed' } } as AnthropicMessagesStreamEventEx);
  expect(await collect(serializeAnthropicMessagesStream(frames([start(0), start(1), error]), true))).toEqual([start(0), error]);
  const failure = new Error('upstream failed');
  await expect(collect(serializeAnthropicMessagesStream((async function* () { yield start(0); yield start(1); throw failure; })(), true))).rejects.toBe(failure);
  await expect(collect(serializeAnthropicMessagesStream(frames([start(0), start(1)]), true))).rejects.toThrow('active item never closed');
});

test('Responses reorder whole item lifecycles and restamp sequence numbers in delivery order', async () => {
  const event = (type: string, output_index: number, sequence_number: number) => eventFrame({ type, output_index, sequence_number } as OpenAIResponsesStreamEventEx);
  const source = [event('response.output_item.added', 0, 0), event('response.output_item.added', 1, 1), event('response.output_text.delta', 1, 2), event('response.function_call_arguments.delta', 0, 3), event('response.output_item.done', 0, 4), event('response.output_item.done', 1, 5), doneFrame()];
  const output = await collect(serializeOpenAIResponsesStream(frames(source), true));
  expect(output.filter(frame => frame.type === 'event').map(frame => frame.event.type)).toEqual(['response.output_item.added', 'response.function_call_arguments.delta', 'response.output_item.done', 'response.output_item.added', 'response.output_text.delta', 'response.output_item.done']);
  expect(output.filter(frame => frame.type === 'event').map(frame => frame.event.sequence_number)).toEqual([0, 1, 2, 3, 4, 5]);
  expect(output.at(-1)).toEqual(doneFrame());
  expect(source[1]).toEqual(event('response.output_item.added', 1, 1));
});
