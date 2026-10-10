import { describe, expect, test, vi } from 'vitest';

import { wrapOpenAIChatCompletionsAffinityEgress } from '../../../../../src/data-plane/chat/openai-chat-completions/affinity/egress.ts';
import type { AffinityCodec, AffinityIdentity } from '../../../../../src/data-plane/chat/shared/affinity/index.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { type OpenAIChatCompletionsAssistantDeltaEx, type OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

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

const withUsage = (event: OpenAIChatCompletionsStreamEvent, output: number): OpenAIChatCompletionsStreamEvent => ({
  ...event,
  usage: { prompt_tokens: 10, completion_tokens: output, total_tokens: 10 + output },
});
const immediateCodec: AffinityEgressCodec = { wrap: async value => `wrapped:${value}` };

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

    expect(output.filter(frame => frame.type === 'event')).toHaveLength(2);
    for (const frame of output) if (frame.type === 'event') expect(frame.event.usage).toEqual(withUsage(chunk([]), 2).usage);
  });

  test('continuous usage keeps unknown accounting null on generated choice frames', async () => {
    const output: ProtocolFrame<OpenAIChatCompletionsStreamEvent>[] = [];
    for await (const frame of wrapOpenAIChatCompletionsAffinityEgress(frames([
      eventFrame(chunk([{ index: 0, delta: { content: 'answer' }, finish_reason: 'stop' }])),
      doneFrame(),
    ]), { codec: immediateCodec, affinity, continuousUsageStats: true })) output.push(frame);

    expect(output.filter(frame => frame.type === 'event')).toHaveLength(1);
    for (const frame of output) if (frame.type === 'event') expect(frame.event.usage).toBeNull();
  });

  test('the DONE carrier uses a single choice final usage snapshot', async () => {
    const output: ProtocolFrame<OpenAIChatCompletionsStreamEvent>[] = [];
    for await (const frame of wrapOpenAIChatCompletionsAffinityEgress(frames([
      eventFrame(withUsage(chunk([{ index: 0, delta: { content: 'answer', reasoning_opaque: 'opaque' }, finish_reason: null }]), 2)),
      eventFrame(withUsage(chunk([]), 4)),
      doneFrame(),
    ]), { codec: immediateCodec, affinity, continuousUsageStats: true })) output.push(frame);

    expect(output[2]).toMatchObject({ event: { choices: [{ index: 0, delta: { reasoning_opaque: 'wrapped:opaque' } }], usage: withUsage(chunk([]), 4).usage } });
    expect(output[3]).toEqual(doneFrame());
  });

  test('continuous usage keeps per-choice snapshots separate from aggregate trailing accounting', async () => {
    const output: ProtocolFrame<OpenAIChatCompletionsStreamEvent>[] = [];
    for await (const frame of wrapOpenAIChatCompletionsAffinityEgress(frames([
      eventFrame(withUsage(chunk([{ index: 0, delta: { content: 'first', reasoning_opaque: 'first-opaque' }, finish_reason: null }]), 2)),
      eventFrame(withUsage(chunk([{ index: 1, delta: { content: 'second', reasoning_opaque: 'second-opaque' }, finish_reason: null }]), 3)),
      eventFrame(withUsage(chunk([]), 5)),
      doneFrame(),
    ]), { codec: immediateCodec, affinity, continuousUsageStats: true })) output.push(frame);

    expect(output.slice(3, 5)).toMatchObject([
      { event: { choices: [{ index: 0, delta: { reasoning_opaque: 'wrapped:first-opaque' } }], usage: withUsage(chunk([]), 2).usage } },
      { event: { choices: [{ index: 1, delta: { reasoning_opaque: 'wrapped:second-opaque' } }], usage: withUsage(chunk([]), 3).usage } },
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

  test('wraps only the latest legacy opaque snapshot before the finish reason', async () => {
    const calls: Array<{ value: string | undefined; domain: string; resolve: (value: string) => void }> = [];
    const codec: AffinityEgressCodec = {
      wrap: (value, _identity, domain) => new Promise(resolve => calls.push({ value, domain, resolve })),
    };
    const output = wrapOpenAIChatCompletionsAffinityEgress(frames([
      eventFrame(chunk([{ index: 0, delta: { content: 'first', reasoning_opaque: 'old' }, finish_reason: null }])),
      eventFrame(chunk([{ index: 0, delta: { content: 'latest', reasoning_opaque: 'new' }, finish_reason: null }])),
      eventFrame(chunk([{ index: 0, delta: {}, finish_reason: 'stop' }])),
      doneFrame(),
    ]), { codec, affinity })[Symbol.asyncIterator]();

    expect((await output.next()).value).toEqual(eventFrame(chunk([{ index: 0, delta: { content: 'first' }, finish_reason: null }])));
    expect((await output.next()).value).toEqual(eventFrame(chunk([{ index: 0, delta: { content: 'latest' }, finish_reason: null }])));
    expect(calls).toHaveLength(0);

    const pending = output.next();
    await vi.waitFor(() => expect(calls.map(call => [call.value, call.domain])).toEqual([['new', 'openai-chat-completions.reasoning_opaque']]));
    calls[0].resolve('wrapped-new');
    expect((await pending).value).toEqual(eventFrame(chunk([{ index: 0, delta: { reasoning_opaque: 'wrapped-new' }, finish_reason: null }])));
    expect((await output.next()).value).toEqual(eventFrame(chunk([{ index: 0, delta: {}, finish_reason: 'stop' }])));
    expect((await output.next()).value).toEqual(doneFrame());
  });

  test('wraps the existing encrypted reasoning detail in place', async () => {
    const calls: Array<{ value: string | undefined; domain: string }> = [];
    const codec: AffinityEgressCodec = {
      wrap: async (value, _identity, domain) => {
        calls.push({ value, domain });
        return `wrapped:${value}`;
      },
    };
    const details = [
      { type: 'reasoning.summary', summary: 'visible', format: 'unknown', index: 0 },
      { type: 'reasoning.encrypted', data: 'sidecar', format: 'unknown', index: 1 },
    ];
    const output: ProtocolFrame<OpenAIChatCompletionsStreamEvent>[] = [];
    for await (const frame of wrapOpenAIChatCompletionsAffinityEgress(frames([
      eventFrame(chunk([{ index: 0, delta: { content: 'answer', reasoning_details: details }, finish_reason: null }])),
      eventFrame(chunk([{ index: 0, delta: {}, finish_reason: 'stop' }])),
      doneFrame(),
    ]), { codec, affinity })) output.push(frame);

    expect(calls).toEqual([{
      value: 'sidecar',
      domain: 'openai-chat-completions.reasoning_details.reasoning.encrypted.data',
    }]);
    expect(output).toEqual([
      eventFrame(chunk([{
        index: 0,
        delta: {
          content: 'answer',
          reasoning_details: [details[0], { ...details[1], data: 'wrapped:sidecar' }],
        },
        finish_reason: null,
      }])),
      eventFrame(chunk([{ index: 0, delta: {}, finish_reason: 'stop' }])),
      doneFrame(),
    ]);
  });

  test('does not add an opaque carrier when none was returned', async () => {
    const calls: string[] = [];
    const codec: AffinityEgressCodec = {
      wrap: async value => {
        calls.push(value ?? 'missing');
        return `wrapped:${value}`;
      },
    };
    const output: ProtocolFrame<OpenAIChatCompletionsStreamEvent>[] = [];
    for await (const frame of wrapOpenAIChatCompletionsAffinityEgress(frames([
      eventFrame(chunk([{ index: 0, delta: { content: 'answer' }, finish_reason: 'stop' }])),
      doneFrame(),
    ]), { codec, affinity })) output.push(frame);

    expect(calls).toEqual([]);
    expect(output).toEqual([
      eventFrame(chunk([{ index: 0, delta: { content: 'answer' }, finish_reason: 'stop' }])),
      doneFrame(),
    ]);
  });

  test('leaves empty opaque values empty and unwrapped', async () => {
    const calls: string[] = [];
    const codec: AffinityEgressCodec = {
      wrap: async value => {
        calls.push(value ?? 'missing');
        return `wrapped:${value}`;
      },
    };
    const details = [{ type: 'reasoning.encrypted', data: '', format: 'unknown', index: 1 }];
    const output: ProtocolFrame<OpenAIChatCompletionsStreamEvent>[] = [];
    for await (const frame of wrapOpenAIChatCompletionsAffinityEgress(frames([
      eventFrame(chunk([{ index: 0, delta: { reasoning_opaque: '', reasoning_details: details }, finish_reason: null }])),
      eventFrame(chunk([{ index: 0, delta: {}, finish_reason: 'stop' }])),
      doneFrame(),
    ]), { codec, affinity })) output.push(frame);

    expect(calls).toEqual([]);
    expect(output).toEqual([
      eventFrame(chunk([{ index: 0, delta: { reasoning_details: details }, finish_reason: null }])),
      eventFrame(chunk([{ index: 0, delta: { reasoning_opaque: '' }, finish_reason: null }])),
      eventFrame(chunk([{ index: 0, delta: {}, finish_reason: 'stop' }])),
      doneFrame(),
    ]);
  });
});
