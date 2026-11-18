import { describe, expect, test } from 'vitest';

import { wrapOpenAIChatCompletionsAffinityEgress } from '../../../../../src/data-plane/chat/openai-chat-completions/affinity/egress.ts';
import type { AffinityCodec, AffinityIdentity } from '../../../../../src/data-plane/chat/shared/affinity/index.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { type OpenAIChatCompletionsAssistantDeltaEx, reassembleOpenAIChatCompletionsEvents, type OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

const affinity: AffinityIdentity = {
  upstreamId: 'up-a',
  modelId: 'model-a',
  opaqueBlobCompatibilityIdentity: { upstreamId: 'up-a', key: 'model-a' },
};

type AffinityEgressCodec = Pick<AffinityCodec, 'wrap'>;

const chunk = (
  choices: Array<Omit<OpenAIChatCompletionsStreamEvent['choices'][number], 'delta'> & { delta: OpenAIChatCompletionsAssistantDeltaEx }>,
): OpenAIChatCompletionsStreamEvent => ({
  id: 'chatcmpl_1',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'model-a',
  choices,
});

const frames = async function* (values: ProtocolFrame<OpenAIChatCompletionsStreamEvent>[]) {
  yield* values;
};

const withChunkExtra = (event: OpenAIChatCompletionsStreamEvent, name: string, value: unknown): OpenAIChatCompletionsStreamEvent => {
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

describe('OpenAI Chat Completions affinity egress', () => {
  test('forwards visible final data before wrapping the last opaque snapshot', async () => {
    const codec = new DelayedCodec();
    const output = wrapOpenAIChatCompletionsAffinityEgress(frames([
      eventFrame(chunk([{  index: 0, delta: { reasoning_opaque: 'first' }, finish_reason: null }])),
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
    const output: ProtocolFrame<OpenAIChatCompletionsStreamEvent>[] = [];
    for await (const frame of wrapOpenAIChatCompletionsAffinityEgress(frames([
      eventFrame(chunk([
        {  index: 0, delta: { reasoning_opaque: 'opaque' }, finish_reason: 'stop' },
        {  index: 1, delta: {}, finish_reason: 'length' },
      ])),
      doneFrame(),
    ]), { codec: immediateCodec, affinity })) output.push(frame);

    expect(output[0]).toEqual(eventFrame(chunk([
      {  index: 0, delta: { reasoning_opaque: 'wrapped:opaque' }, finish_reason: null },
      {  index: 1, delta: { reasoning_opaque: 'wrapped:synthetic' }, finish_reason: null },
    ])));
    expect(output[1]).toEqual(eventFrame(chunk([
      {  index: 0, delta: {}, finish_reason: 'stop' },
      {  index: 1, delta: {}, finish_reason: 'length' },
    ])));
  });

  test('flushes a carrier before DONE when an upstream omits finish_reason', async () => {
    const output: ProtocolFrame<OpenAIChatCompletionsStreamEvent>[] = [];
    for await (const frame of wrapOpenAIChatCompletionsAffinityEgress(frames([
      eventFrame(chunk([{  index: 0, delta: { content: 'visible' }, finish_reason: null }])),
      doneFrame(),
    ]), { codec: immediateCodec, affinity })) output.push(frame);

    expect(output).toEqual([
      eventFrame(chunk([{  index: 0, delta: { content: 'visible' }, finish_reason: null }])),
      eventFrame(chunk([{  index: 0, delta: { reasoning_opaque: 'wrapped:synthetic' }, finish_reason: null }])),
      doneFrame(),
    ]);
  });

  test('emits final chunk extras once across split frames and non-stream reassembly', async () => {
    const output: ProtocolFrame<OpenAIChatCompletionsStreamEvent>[] = [];
    for await (const frame of wrapOpenAIChatCompletionsAffinityEgress(frames([
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
    expect(await reassembleOpenAIChatCompletionsEvents(chunks())).toMatchObject({ vendor_text: 'x' });
  });
});
