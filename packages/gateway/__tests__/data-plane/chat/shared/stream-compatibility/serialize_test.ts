import { expect, test } from 'vitest';

import { serializeAnthropicMessagesStream, serializeOpenAIResponsesStream, shouldSerializeStreamItems } from '../../../../../src/data-plane/chat/shared/stream-compatibility/index.ts';
import type { Result } from '@floway-dev/pipeline';
import type { AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import type { FlagId, ProtocolStreamError } from '@floway-dev/provider';

const frames = async function* <T>(values: T[]) { yield* values; };
const collect = async <T>(source: AsyncIterable<T>): Promise<T[]> => { const output: T[] = []; for await (const value of source) output.push(value); return output; };
type AnthropicItem = Result<AnthropicMessagesStreamEventEx, ProtocolStreamError>;
const success = (value: AnthropicMessagesStreamEventEx): AnthropicItem => ({ ok: true, value });
const start = (index: number) => success({ type: 'content_block_start', index, content_block: { type: 'text', text: '', citations: null } });
const delta = (index: number, text: string) => success({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } });
const stop = (index: number) => success({ type: 'content_block_stop', index });

test('disabled mode returns the original iterable and automatic UA handling never changes the flag set', () => {
  const source = frames([start(0), start(1), stop(0), stop(1)]);
  expect(serializeAnthropicMessagesStream(source, false)).toBe(source);
  const flags = new Set<FlagId>();
  // The version match is token-bounded: a longer version string must not match.
  expect(shouldSerializeStreamItems(flags, 'anthropicMessages', 'custom/1 ai-sdk-anthropic/4.0.71 extra')).toBe(true);
  expect(shouldSerializeStreamItems(flags, 'anthropicMessages', 'ai-sdk-anthropic/4.0.710')).toBe(false);
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
  const thinking = success({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } });
  const signature = success({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signed' } });
  const source = [thinking, start(1), delta(1, 'answer'), signature, stop(0), stop(1)];
  expect(await collect(serializeAnthropicMessagesStream(frames(source), true))).toEqual([thinking, signature, stop(0), start(1), delta(1, 'answer'), stop(1)]);
});

test('sidecar crosses an open final block only when item serialization is disabled', async () => {
  const sidecar = success({ type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'sidecar' } });
  const source = [start(0), delta(0, 'answer'), sidecar, stop(1), stop(0)];
  expect(await collect(serializeAnthropicMessagesStream(frames(source), false))).toEqual(source);
  expect(await collect(serializeAnthropicMessagesStream(frames(source), true))).toEqual([
    start(0), delta(0, 'answer'), stop(0), sidecar, stop(1),
  ]);
});

test('errors discard withheld items and upstream failures retain the original error object', async () => {
  const error: AnthropicItem = {
    ok: false, error: {
      kind: 'protocol', cause: new Error('failed'),
      event: { type: 'error', error: { type: 'overloaded_error', message: 'failed' } },
    },
  };
  expect(await collect(serializeAnthropicMessagesStream(frames([start(0), start(1), error]), true))).toEqual([start(0), error]);
  const failure = new Error('upstream failed');
  await expect(collect(serializeAnthropicMessagesStream((async function* () { yield start(0); yield start(1); throw failure; })(), true))).rejects.toBe(failure);
  const incomplete = await collect(serializeAnthropicMessagesStream(frames([start(0), start(1)]), true));
  expect(incomplete).toEqual([start(0), { ok: false, error: { kind: 'protocol', cause: new Error('Cannot serialize an interleaved stream whose active item never closed') } }]);
});

test('an active block cannot buffer arbitrarily many later frames', async () => {
  const source = (async function* () {
    yield start(0);
    for (let index = 1; index < 17_000; index++) yield start(index);
  })();
  await expect(collect(serializeAnthropicMessagesStream(source, true))).rejects.toThrow(/buffered frames/);
});

type ResponsesItem = Result<OpenAIResponsesStreamEventEx, ProtocolStreamError>;
const responseItem = (type: string, output_index: number, sequence_number: number): ResponsesItem => ({
  ok: true, value: { type, output_index, sequence_number } as OpenAIResponsesStreamEventEx,
});

test('Responses reorder whole item lifecycles and restamp sequence numbers in delivery order', async () => {
  const source = [
    responseItem('response.output_item.added', 0, 0), responseItem('response.output_item.added', 1, 1),
    responseItem('response.output_text.delta', 1, 2), responseItem('response.function_call_arguments.delta', 0, 3),
    responseItem('response.output_item.done', 0, 4), responseItem('response.output_item.done', 1, 5),
  ];
  const output = await collect(serializeOpenAIResponsesStream(frames(source), true));
  expect(output.filter(frame => frame.ok).map(frame => frame.value.type)).toEqual(['response.output_item.added', 'response.function_call_arguments.delta', 'response.output_item.done', 'response.output_item.added', 'response.output_text.delta', 'response.output_item.done']);
  expect(output.filter(frame => frame.ok).map(frame => frame.value.sequence_number)).toEqual([0, 1, 2, 3, 4, 5]);
  expect(source[1]).toEqual(responseItem('response.output_item.added', 1, 1));
});

test('Responses serialization forwards an ordinary transport failure while another item is buffered', async () => {
  const first = responseItem('response.output_item.added', 0, 0);
  const other = responseItem('response.output_item.added', 1, 1);
  const error: ResponsesItem = { ok: false, error: { kind: 'transport', cause: new Error('upstream disconnected') } };
  const output = await collect(serializeOpenAIResponsesStream(frames([first, other, error]), true));
  expect(output).toEqual([first, error]);
  expect(output.at(-1)).toBe(error);
});
