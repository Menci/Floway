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

const withChoiceExtra = (event: OpenAIChatCompletionsStreamEvent, name: string, value: unknown): OpenAIChatCompletionsStreamEvent => {
  Object.assign(event.choices[0], { [name]: value });
  return event;
};

const withChunkExtra = (event: OpenAIChatCompletionsStreamEvent, name: string, value: unknown): OpenAIChatCompletionsStreamEvent => {
  Object.assign(event, { [name]: value });
  return event;
};

const withUsage = (event: OpenAIChatCompletionsStreamEvent, output: number): OpenAIChatCompletionsStreamEvent => ({
  ...event,
  usage: { prompt_tokens: 10, completion_tokens: output, total_tokens: 10 + output },
});

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
  test('continuous usage follows visible, encrypted carrier and finishing choice frames', async () => {
    const output: ProtocolFrame<OpenAIChatCompletionsStreamEvent>[] = [];
    for await (const frame of wrapOpenAIChatCompletionsAffinityEgress(frames([
      eventFrame(withUsage(chunk([{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]), 0)),
      eventFrame(withUsage(chunk([{ index: 0, delta: { content: 'answer', reasoning_opaque: 'opaque' }, finish_reason: 'stop' }]), 4)),
      doneFrame(),
    ]), { codec: immediateCodec, affinity, continuousUsageStats: true })) output.push(frame);

    const chunks = output.flatMap(frame => frame.type === 'event' && frame.event.choices.length > 0 ? [frame.event] : []);
    expect(chunks.map(event => event.usage)).toEqual([
      withUsage(chunk([]), 0).usage,
      withUsage(chunk([]), 4).usage,
      withUsage(chunk([]), 4).usage,
      withUsage(chunk([]), 4).usage,
    ]);
    expect(chunks.map(event => event.choices[0].delta)).toEqual([
      { role: 'assistant' }, { content: 'answer' }, { reasoning_opaque: 'wrapped:opaque' }, {},
    ]);
    expect(chunks.at(-1)?.choices[0].finish_reason).toBe('stop');
  });

  test('continuous usage preserves the latest known counters across a usage-less finish', async () => {
    const output: ProtocolFrame<OpenAIChatCompletionsStreamEvent>[] = [];
    for await (const frame of wrapOpenAIChatCompletionsAffinityEgress(frames([
      eventFrame(withUsage(chunk([{ index: 0, delta: { content: 'answer' }, finish_reason: null }]), 2)),
      eventFrame(chunk([{ index: 0, delta: {}, finish_reason: 'stop' }])),
      doneFrame(),
    ]), { codec: immediateCodec, affinity, continuousUsageStats: true })) output.push(frame);

    expect(output.filter(frame => frame.type === 'event')).toHaveLength(3);
    for (const frame of output) if (frame.type === 'event') expect(frame.event.usage).toEqual(withUsage(chunk([]), 2).usage);
  });

  test('continuous usage keeps unknown accounting null on generated choice frames', async () => {
    const output: ProtocolFrame<OpenAIChatCompletionsStreamEvent>[] = [];
    for await (const frame of wrapOpenAIChatCompletionsAffinityEgress(frames([
      eventFrame(chunk([{ index: 0, delta: { content: 'answer' }, finish_reason: 'stop' }])),
      doneFrame(),
    ]), { codec: immediateCodec, affinity, continuousUsageStats: true })) output.push(frame);

    expect(output.filter(frame => frame.type === 'event')).toHaveLength(3);
    for (const frame of output) if (frame.type === 'event') expect(frame.event.usage).toBeNull();
  });

  test('the DONE carrier uses a single choice final usage snapshot', async () => {
    const output: ProtocolFrame<OpenAIChatCompletionsStreamEvent>[] = [];
    for await (const frame of wrapOpenAIChatCompletionsAffinityEgress(frames([
      eventFrame(withUsage(chunk([{ index: 0, delta: { content: 'answer' }, finish_reason: null }]), 2)),
      eventFrame(withUsage(chunk([]), 4)),
      doneFrame(),
    ]), { codec: immediateCodec, affinity, continuousUsageStats: true })) output.push(frame);

    expect(output[2]).toMatchObject({ event: { choices: [{ index: 0, delta: { reasoning_opaque: 'wrapped:synthetic' } }], usage: withUsage(chunk([]), 4).usage } });
    expect(output[3]).toEqual(doneFrame());
  });

  test('continuous usage keeps per-choice snapshots separate from aggregate trailing accounting', async () => {
    const output: ProtocolFrame<OpenAIChatCompletionsStreamEvent>[] = [];
    for await (const frame of wrapOpenAIChatCompletionsAffinityEgress(frames([
      eventFrame(withUsage(chunk([{ index: 0, delta: { content: 'first' }, finish_reason: null }]), 2)),
      eventFrame(withUsage(chunk([{ index: 1, delta: { content: 'second' }, finish_reason: null }]), 3)),
      eventFrame(withUsage(chunk([]), 5)),
      doneFrame(),
    ]), { codec: immediateCodec, affinity, continuousUsageStats: true })) output.push(frame);

    expect(output.slice(3, 5)).toMatchObject([
      { event: { choices: [{ index: 0, delta: { reasoning_opaque: 'wrapped:synthetic' } }], usage: withUsage(chunk([]), 2).usage } },
      { event: { choices: [{ index: 1, delta: { reasoning_opaque: 'wrapped:synthetic' } }], usage: withUsage(chunk([]), 3).usage } },
    ]);
    expect(output[2]).toMatchObject({ event: { choices: [], usage: withUsage(chunk([]), 5).usage } });
  });

  test.each([undefined, false])('default usage remains on the original projection only (continuous=%s)', async continuousUsageStats => {
    const output: ProtocolFrame<OpenAIChatCompletionsStreamEvent>[] = [];
    for await (const frame of wrapOpenAIChatCompletionsAffinityEgress(frames([
      eventFrame(withUsage(chunk([{ index: 0, delta: { content: 'answer' }, finish_reason: 'stop' }]), 4)),
      doneFrame(),
    ]), { codec: immediateCodec, affinity, continuousUsageStats })) output.push(frame);

    expect(output[0]).toMatchObject({ event: { usage: withUsage(chunk([]), 4).usage } });
    for (const frame of output.slice(1)) if (frame.type === 'event') expect(frame.event).not.toHaveProperty('usage');
  });

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

  test('does not turn a successful empty upstream stream into an affinity error', async () => {
    const output: ProtocolFrame<OpenAIChatCompletionsStreamEvent>[] = [];
    for await (const frame of wrapOpenAIChatCompletionsAffinityEgress(
      frames([doneFrame()]),
      { codec: immediateCodec, affinity },
    )) output.push(frame);

    expect(output).toEqual([doneFrame()]);
  });

  test('emits choice extras once on the visible projection before carrier encryption', async () => {
    const codec = new DelayedCodec();
    const output = wrapOpenAIChatCompletionsAffinityEgress(frames([
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
    const output: ProtocolFrame<OpenAIChatCompletionsStreamEvent>[] = [];
    for await (const frame of wrapOpenAIChatCompletionsAffinityEgress(frames([
      eventFrame(withChoiceExtra(chunk([{  index: 0, delta: { reasoning_opaque: 'opaque' }, finish_reason: null }]), 'logprobs', null)),
      eventFrame(chunk([{  index: 0, delta: {}, finish_reason: 'stop' }])),
      doneFrame(),
    ]), { codec: immediateCodec, affinity })) output.push(frame);

    expect(output[0]).toEqual(eventFrame(withChoiceExtra(chunk([{  index: 0, delta: {}, finish_reason: null }]), 'logprobs', null)));
    expect(JSON.stringify(output.slice(1))).not.toContain('logprobs');
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

  test('preserves chunk extras from an opaque-only nonterminal event', async () => {
    const output: ProtocolFrame<OpenAIChatCompletionsStreamEvent>[] = [];
    for await (const frame of wrapOpenAIChatCompletionsAffinityEgress(frames([
      eventFrame(withChunkExtra(
        chunk([{  index: 0, delta: { reasoning_opaque: 'opaque' }, finish_reason: null }]),
        'vendor_scalar',
        7,
      )),
      eventFrame(chunk([{  index: 0, delta: {}, finish_reason: 'stop' }])),
      doneFrame(),
    ]), { codec: immediateCodec, affinity })) output.push(frame);

    expect(output[0]).toMatchObject({ event: { choices: [], vendor_scalar: 7 } });
    expect(JSON.stringify(output.slice(1))).not.toContain('vendor_scalar');
  });
});
