import { describe, expect, test, vi } from 'vitest';

import { wrapMessagesAffinityEgress } from './egress.ts';
import type { AffinityCodec, AffinityTarget } from '../../shared/affinity/index.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesStreamEvent } from '@floway-dev/protocols/messages';

const affinity: AffinityTarget = {
  upstreamId: 'up-a',
  modelId: 'model-a',
};

type AffinityEgressCodec = Pick<AffinityCodec, 'wrap'>;

const frames = async function* (values: ProtocolFrame<MessagesStreamEvent>[]) {
  yield* values;
};

class DelayedCodec implements AffinityEgressCodec {
  readonly calls: Array<{ value: string | undefined; resolve: (value: string) => void }> = [];

  wrap(value: string | undefined): Promise<string> {
    return new Promise(resolve => this.calls.push({ value, resolve }));
  }
}

const immediateCodec: AffinityEgressCodec = {
  wrap: async value => `wrapped:${value ?? 'synthetic'}`,
};

describe('Messages affinity egress', () => {
  test('streams readable thinking and wraps the latest signature snapshot at block stop', async () => {
    const codec = new DelayedCodec();
    const output = wrapMessagesAffinityEgress(frames([
      eventFrame({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
      eventFrame({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'visible' } }),
      eventFrame({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'first' } }),
      eventFrame({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'latest' } }),
      eventFrame({ type: 'content_block_stop', index: 0 }),
      eventFrame({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
      eventFrame({ type: 'message_stop' }),
    ]), { codec, affinity })[Symbol.asyncIterator]();

    expect((await output.next()).value).toMatchObject({ event: { type: 'content_block_start' } });
    expect((await output.next()).value).toEqual(eventFrame({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'visible' },
    }));
    expect(codec.calls).toHaveLength(0);

    const signaturePending = output.next();
    await vi.waitFor(() => expect(codec.calls.map(call => call.value)).toEqual(['latest']));
    codec.calls[0].resolve('wrapped-latest');
    expect((await signaturePending).value).toEqual(eventFrame({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: 'wrapped-latest' },
    }));
    expect((await output.next()).value).toEqual(eventFrame({ type: 'content_block_stop', index: 0 }));
    expect((await output.next()).value).toMatchObject({ event: { type: 'message_delta' } });
  });

  test('retains extension fields from the latest natural signature event', async () => {
    const signature = {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: 'natural', vendor_delta: 'delta-extra' },
      vendor_event: 'event-extra',
    } as unknown as MessagesStreamEvent;
    const output: ProtocolFrame<MessagesStreamEvent>[] = [];
    for await (const frame of wrapMessagesAffinityEgress(frames([
      eventFrame({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
      eventFrame(signature),
      eventFrame({ type: 'content_block_stop', index: 0 }),
      eventFrame({ type: 'message_stop' }),
    ]), { codec: immediateCodec, affinity })) output.push(frame);

    expect(output[1]).toMatchObject({
      event: {
        type: 'content_block_delta',
        index: 0,
        vendor_event: 'event-extra',
        delta: {
          type: 'signature_delta',
          signature: 'wrapped:natural',
          vendor_delta: 'delta-extra',
        },
      },
    });
  });

  test('wraps redacted data inline and does not inject another carrier', async () => {
    const output: ProtocolFrame<MessagesStreamEvent>[] = [];
    for await (const frame of wrapMessagesAffinityEgress(frames([
      eventFrame({ type: 'content_block_start', index: 2, content_block: { type: 'redacted_thinking', data: 'opaque' } }),
      eventFrame({ type: 'content_block_stop', index: 2 }),
      eventFrame({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
      eventFrame({ type: 'message_stop' }),
    ]), { codec: immediateCodec, affinity })) output.push(frame);

    expect(output[0]).toEqual(eventFrame({
      type: 'content_block_start',
      index: 2,
      content_block: { type: 'redacted_thinking', data: 'wrapped:opaque' },
    }));
    expect(output.filter(frame => frame.type === 'event' && frame.event.type === 'content_block_start')).toHaveLength(1);
  });

  test('prefixes a synthetic redacted block before a first text block and shifts its index', async () => {
    const output: ProtocolFrame<MessagesStreamEvent>[] = [];
    for await (const frame of wrapMessagesAffinityEgress(frames([
      eventFrame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      eventFrame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'answer' } }),
      eventFrame({ type: 'content_block_stop', index: 0 }),
      eventFrame({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
      eventFrame({ type: 'message_stop' }),
    ]), { codec: immediateCodec, affinity })) output.push(frame);

    expect(output.slice(0, 5)).toEqual([
      eventFrame({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'redacted_thinking', data: 'wrapped:synthetic' },
      }),
      eventFrame({ type: 'content_block_stop', index: 0 }),
      eventFrame({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
      eventFrame({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'answer' } }),
      eventFrame({ type: 'content_block_stop', index: 1 }),
    ]);
  });

  test('adds an originless signature to a first thinking block without a natural signature', async () => {
    const output: ProtocolFrame<MessagesStreamEvent>[] = [];
    for await (const frame of wrapMessagesAffinityEgress(frames([
      eventFrame({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
      eventFrame({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'visible' } }),
      eventFrame({ type: 'content_block_stop', index: 0 }),
      eventFrame({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
      eventFrame({ type: 'message_stop' }),
    ]), { codec: immediateCodec, affinity })) output.push(frame);

    expect(output.slice(0, 4)).toEqual([
      eventFrame({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
      eventFrame({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'visible' } }),
      eventFrame({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'wrapped:synthetic' } }),
      eventFrame({ type: 'content_block_stop', index: 0 }),
    ]);
  });

  test('emits one prefix for an empty message with both terminal events', async () => {
    const output: ProtocolFrame<MessagesStreamEvent>[] = [];
    for await (const frame of wrapMessagesAffinityEgress(frames([
      eventFrame({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
      eventFrame({ type: 'message_stop' }),
    ]), { codec: immediateCodec, affinity })) output.push(frame);

    expect(output.filter(frame => frame.type === 'event' && frame.event.type === 'content_block_start')).toHaveLength(1);
    expect(output.map(frame => frame.type === 'event' ? frame.event.type : frame.type)).toEqual([
      'content_block_start',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
  });
});
