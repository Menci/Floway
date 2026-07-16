import { describe, expect, test } from 'vitest';

import { wrapChatCompletionsAffinityEgress } from './egress.ts';
import type { AffinityCodec, AffinityTarget } from '../../shared/affinity/index.ts';
import { reassembleChatCompletionsEvents, type ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';

const affinity: AffinityTarget = {
  upstreamId: 'up-a',
  modelId: 'model-a',
};

type AffinityEgressCodec = Pick<AffinityCodec, 'wrap'>;

const chunk = (
  choices: ChatCompletionsStreamEvent['choices'],
): ChatCompletionsStreamEvent => ({
  id: 'chatcmpl_1',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'model-a',
  choices,
});

const frames = async function* (values: ProtocolFrame<ChatCompletionsStreamEvent>[]) {
  yield* values;
};

const withChoiceExtra = (event: ChatCompletionsStreamEvent, name: string, value: unknown): ChatCompletionsStreamEvent => {
  Object.assign(event.choices[0], { [name]: value });
  return event;
};

const withChunkExtra = (event: ChatCompletionsStreamEvent, name: string, value: unknown): ChatCompletionsStreamEvent => {
  Object.assign(event, { [name]: value });
  return event;
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

describe('Chat Completions affinity egress', () => {
  test('forwards visible final data before wrapping the last opaque snapshot', async () => {
    const codec = new DelayedCodec();
    const output = wrapChatCompletionsAffinityEgress(frames([
      eventFrame(chunk([{ index: 0, delta: { reasoning_opaque: 'first' }, finish_reason: null }])),
      eventFrame(chunk([{
        index: 0,
        delta: { content: 'visible', reasoning_text: 'thinking', reasoning_opaque: 'latest' },
        finish_reason: 'stop',
      }])),
      doneFrame(),
    ]), { codec, affinity })[Symbol.asyncIterator]();

    const visible = await output.next();
    expect(visible.value).toEqual(eventFrame(chunk([{
      index: 0,
      delta: { content: 'visible', reasoning_text: 'thinking' },
      finish_reason: null,
    }])));
    expect(codec.calls).toHaveLength(0);

    const wrappedPending = output.next();
    await Promise.resolve();
    expect(codec.calls.map(call => call.value)).toEqual(['latest']);
    codec.calls[0].resolve('wrapped-latest');
    expect((await wrappedPending).value).toEqual(eventFrame(chunk([{
      index: 0,
      delta: { reasoning_opaque: 'wrapped-latest' },
      finish_reason: null,
    }])));

    expect((await output.next()).value).toEqual(eventFrame(chunk([{
      index: 0,
      delta: {},
      finish_reason: 'stop',
    }])));
    expect((await output.next()).value).toEqual(doneFrame());
  });

  test('wraps or synthesizes a carrier independently for every finishing choice', async () => {
    const output: ProtocolFrame<ChatCompletionsStreamEvent>[] = [];
    for await (const frame of wrapChatCompletionsAffinityEgress(frames([
      eventFrame(chunk([
        { index: 0, delta: { reasoning_opaque: 'opaque' }, finish_reason: 'stop' },
        { index: 1, delta: {}, finish_reason: 'length' },
      ])),
      doneFrame(),
    ]), { codec: immediateCodec, affinity })) output.push(frame);

    expect(output[0]).toEqual(eventFrame(chunk([
      { index: 0, delta: { reasoning_opaque: 'wrapped:opaque' }, finish_reason: null },
      { index: 1, delta: { reasoning_opaque: 'wrapped:synthetic' }, finish_reason: null },
    ])));
    expect(output[1]).toEqual(eventFrame(chunk([
      { index: 0, delta: {}, finish_reason: 'stop' },
      { index: 1, delta: {}, finish_reason: 'length' },
    ])));
  });

  test('flushes a carrier before DONE when an upstream omits finish_reason', async () => {
    const output: ProtocolFrame<ChatCompletionsStreamEvent>[] = [];
    for await (const frame of wrapChatCompletionsAffinityEgress(frames([
      eventFrame(chunk([{ index: 0, delta: { content: 'visible' }, finish_reason: null }])),
      doneFrame(),
    ]), { codec: immediateCodec, affinity })) output.push(frame);

    expect(output).toEqual([
      eventFrame(chunk([{ index: 0, delta: { content: 'visible' }, finish_reason: null }])),
      eventFrame(chunk([{ index: 0, delta: { reasoning_opaque: 'wrapped:synthetic' }, finish_reason: null }])),
      doneFrame(),
    ]);
  });

  test('rejects a successful stream that ends without an assistant choice', async () => {
    const collect = async () => {
      const output: ProtocolFrame<ChatCompletionsStreamEvent>[] = [];
      for await (const frame of wrapChatCompletionsAffinityEgress(
        frames([doneFrame()]),
        { codec: immediateCodec, affinity },
      )) output.push(frame);
      return output;
    };

    await expect(collect()).rejects.toThrow('Chat Completions stream ended without an assistant choice');
  });

  test('emits choice extras once on the visible projection before carrier encryption', async () => {
    const codec = new DelayedCodec();
    const output = wrapChatCompletionsAffinityEgress(frames([
      eventFrame(withChoiceExtra(chunk([{
        index: 0,
        delta: { content: 'visible', reasoning_opaque: 'opaque' },
        finish_reason: 'stop',
      }]), 'logprobs', { content: [] })),
      doneFrame(),
    ]), { codec, affinity })[Symbol.asyncIterator]();

    expect((await output.next()).value).toEqual(eventFrame(withChoiceExtra(chunk([{
      index: 0,
      delta: { content: 'visible' },
      finish_reason: null,
    }]), 'logprobs', { content: [] })));
    expect(codec.calls).toHaveLength(0);

    const carrier = output.next();
    await Promise.resolve();
    codec.calls[0].resolve('wrapped-opaque');
    expect(JSON.stringify((await carrier).value)).not.toContain('logprobs');
    expect(JSON.stringify((await output.next()).value)).not.toContain('logprobs');
  });

  test('does not drop extras from an opaque-only nonterminal choice', async () => {
    const output: ProtocolFrame<ChatCompletionsStreamEvent>[] = [];
    for await (const frame of wrapChatCompletionsAffinityEgress(frames([
      eventFrame(withChoiceExtra(chunk([{ index: 0, delta: { reasoning_opaque: 'opaque' }, finish_reason: null }]), 'logprobs', null)),
      eventFrame(chunk([{ index: 0, delta: {}, finish_reason: 'stop' }])),
      doneFrame(),
    ]), { codec: immediateCodec, affinity })) output.push(frame);

    expect(output[0]).toEqual(eventFrame(withChoiceExtra(chunk([{ index: 0, delta: {}, finish_reason: null }]), 'logprobs', null)));
    expect(JSON.stringify(output.slice(1))).not.toContain('logprobs');
  });

  test('emits final chunk extras once across split frames and non-stream reassembly', async () => {
    const output: ProtocolFrame<ChatCompletionsStreamEvent>[] = [];
    for await (const frame of wrapChatCompletionsAffinityEgress(frames([
      eventFrame(withChunkExtra(chunk([{
        index: 0,
        delta: { content: 'answer', reasoning_opaque: 'opaque' },
        finish_reason: 'stop',
      }]), 'vendor_text', 'x')),
      doneFrame(),
    ]), { codec: immediateCodec, affinity })) output.push(frame);

    expect(JSON.stringify(output).match(/vendor_text/g)).toHaveLength(1);
    const chunks = async function* () {
      for (const frame of output) if (frame.type === 'event') yield frame.event;
    };
    expect(await reassembleChatCompletionsEvents(chunks())).toMatchObject({ vendor_text: 'x' });
  });

  test('preserves chunk extras from an opaque-only nonterminal event', async () => {
    const output: ProtocolFrame<ChatCompletionsStreamEvent>[] = [];
    for await (const frame of wrapChatCompletionsAffinityEgress(frames([
      eventFrame(withChunkExtra(
        chunk([{ index: 0, delta: { reasoning_opaque: 'opaque' }, finish_reason: null }]),
        'vendor_scalar',
        7,
      )),
      eventFrame(chunk([{ index: 0, delta: {}, finish_reason: 'stop' }])),
      doneFrame(),
    ]), { codec: immediateCodec, affinity })) output.push(frame);

    expect(output[0]).toMatchObject({ event: { choices: [], vendor_scalar: 7 } });
    expect(JSON.stringify(output.slice(1))).not.toContain('vendor_scalar');
  });
});
