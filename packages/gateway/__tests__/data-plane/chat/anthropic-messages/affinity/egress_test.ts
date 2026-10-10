import { describe, expect, test, vi } from 'vitest';

import { wrapAnthropicMessagesAffinityEgress } from '../../../../../src/data-plane/chat/anthropic-messages/affinity/egress.ts';
import type { AffinityCodec, AffinityIdentity } from '../../../../../src/data-plane/chat/shared/affinity/index.ts';
import type { AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';

const affinity: AffinityIdentity = {
  upstreamId: 'up-a',
  modelId: 'model-a',
  opaqueBlobCompatibilityIdentity: { upstreamId: 'up-a', key: 'model-a' },
};

type AffinityEgressCodec = Pick<AffinityCodec, 'wrap'>;

const frames = async function* (values: ProtocolFrame<AnthropicMessagesStreamEventEx>[]) {
  yield* values;
};

const immediateCodec: AffinityEgressCodec = {
  wrap: async value => `wrapped:${value}`,
};

describe('Anthropic Messages affinity egress', () => {
  test('wraps only the latest thinking signature snapshot at block stop', async () => {
    const codec: AffinityEgressCodec = {
      wrap: vi.fn(async value => `wrapped:${value}`),
    };
    const output = wrapAnthropicMessagesAffinityEgress(frames([
      eventFrame({ type: 'content_block_start', index: 0, content_block: { signature: '', type: 'thinking', thinking: '' } }),
      eventFrame({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'visible' } }),
      eventFrame({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'first' } }),
      eventFrame({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'latest' } }),
      eventFrame({ type: 'content_block_stop', index: 0 }),
      eventFrame({ type: 'message_stop' }),
    ]), { codec, affinity })[Symbol.asyncIterator]();

    expect((await output.next()).value).toEqual(eventFrame({
      type: 'content_block_start', index: 0, content_block: { signature: '', type: 'thinking', thinking: '' },
    }));
    expect((await output.next()).value).toEqual(eventFrame({
      type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'visible' },
    }));
    expect(codec.wrap).not.toHaveBeenCalled();

    const signaturePending = output.next();
    await vi.waitFor(() => expect(codec.wrap).toHaveBeenCalledTimes(1));
    expect(codec.wrap).toHaveBeenCalledWith('latest', affinity, 'anthropic-messages.thinking.signature');
    expect((await signaturePending).value).toEqual(eventFrame({
      type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'wrapped:latest' },
    }));
    expect((await output.next()).value).toEqual(eventFrame({ type: 'content_block_stop', index: 0 }));
    expect((await output.next()).value).toEqual(eventFrame({ type: 'message_stop' }));
  });

  test('wraps an existing thinking signature on block start in place', async () => {
    const output: ProtocolFrame<AnthropicMessagesStreamEventEx>[] = [];
    for await (const frame of wrapAnthropicMessagesAffinityEgress(frames([
      eventFrame({ type: 'content_block_start', index: 3, content_block: { signature: 'native', type: 'thinking', thinking: '' } }),
      eventFrame({ type: 'content_block_stop', index: 3 }),
      eventFrame({ type: 'message_stop' }),
    ]), { codec: immediateCodec, affinity })) output.push(frame);

    expect(output).toEqual([
      eventFrame({ type: 'content_block_start', index: 3, content_block: { signature: 'wrapped:native', type: 'thinking', thinking: '' } }),
      eventFrame({ type: 'content_block_stop', index: 3 }),
      eventFrame({ type: 'message_stop' }),
    ]);
  });

  test('wraps redacted data at its existing block index', async () => {
    const output: ProtocolFrame<AnthropicMessagesStreamEventEx>[] = [];
    for await (const frame of wrapAnthropicMessagesAffinityEgress(frames([
      eventFrame({ type: 'content_block_start', index: 2, content_block: { type: 'redacted_thinking', data: 'opaque' } }),
      eventFrame({ type: 'content_block_stop', index: 2 }),
      eventFrame({ type: 'message_stop' }),
    ]), { codec: immediateCodec, affinity })) output.push(frame);

    expect(output).toEqual([
      eventFrame({ type: 'content_block_start', index: 2, content_block: { type: 'redacted_thinking', data: 'wrapped:opaque' } }),
      eventFrame({ type: 'content_block_stop', index: 2 }),
      eventFrame({ type: 'message_stop' }),
    ]);
  });

  test('preserves empty signature placeholders and adds no signature or block', async () => {
    const codec: AffinityEgressCodec = { wrap: vi.fn(async value => `wrapped:${value}`) };
    const input: ProtocolFrame<AnthropicMessagesStreamEventEx>[] = [
      eventFrame({ type: 'content_block_start', index: 0, content_block: { signature: '', type: 'thinking', thinking: '' } }),
      eventFrame({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'visible' } }),
      eventFrame({ type: 'content_block_stop', index: 0 }),
      eventFrame({ type: 'message_stop' }),
    ];
    const output: ProtocolFrame<AnthropicMessagesStreamEventEx>[] = [];
    for await (const frame of wrapAnthropicMessagesAffinityEgress(frames(input), { codec, affinity })) output.push(frame);

    expect(codec.wrap).not.toHaveBeenCalled();
    expect(output).toEqual(input);
  });

  test('does not add a redacted block to a text-only or empty message', async () => {
    const input = [
      eventFrame({ type: 'content_block_start', index: 0, content_block: { citations: null, type: 'text', text: '' } }),
      eventFrame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'answer' } }),
      eventFrame({ type: 'content_block_stop', index: 0 }),
      eventFrame({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 0, output_tokens: 0 } }),
      eventFrame({ type: 'message_stop' }),
    ] as ProtocolFrame<AnthropicMessagesStreamEventEx>[];
    const empty = [
      eventFrame({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 0, output_tokens: 0 } }),
      eventFrame({ type: 'message_stop' }),
    ] as ProtocolFrame<AnthropicMessagesStreamEventEx>[];

    const textOutput: ProtocolFrame<AnthropicMessagesStreamEventEx>[] = [];
    for await (const frame of wrapAnthropicMessagesAffinityEgress(frames(input), { codec: immediateCodec, affinity })) textOutput.push(frame);
    const emptyOutput: ProtocolFrame<AnthropicMessagesStreamEventEx>[] = [];
    for await (const frame of wrapAnthropicMessagesAffinityEgress(frames(empty), { codec: immediateCodec, affinity })) emptyOutput.push(frame);

    expect(textOutput).toEqual(input);
    expect(emptyOutput).toEqual(empty);
  });
});
