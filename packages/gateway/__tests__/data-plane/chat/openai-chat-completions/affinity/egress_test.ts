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

describe('OpenAI Chat Completions affinity egress', () => {
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
