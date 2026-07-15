import { describe, expect, test, vi } from 'vitest';

import { wrapResponsesAffinityEgress } from './egress.ts';
import type { AffinityCodec } from '../../shared/affinity/codec.ts';
import type { AffinityTarget } from '../../shared/affinity/types.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesOutputReasoning, ResponsesResult, ResponsesStreamEvent } from '@floway-dev/protocols/responses';

const affinity: AffinityTarget = {
  mode: 'prefer',
  upstreamId: 'up-a',
  modelId: 'model-a',
  rulesPresent: false,
};

type AffinityEgressCodec = Pick<AffinityCodec, 'wrap'>;

const frames = async function* (values: ProtocolFrame<ResponsesStreamEvent>[]) {
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

const response = (output: ResponsesResult['output'], status: ResponsesResult['status'] = 'completed'): ResponsesResult => ({
  id: 'resp_1',
  object: 'response',
  model: 'model-a',
  output,
  status,
  error: null,
  incomplete_details: null,
});

describe('Responses affinity egress', () => {
  test('passes reasoning summary deltas before wrapping and reuses one exact replacement', async () => {
    const codec = new DelayedCodec();
    const item: ResponsesOutputReasoning = {
      type: 'reasoning',
      id: 'rs_1',
      summary: [{ type: 'summary_text', text: 'visible' }],
      encrypted_content: 'opaque',
    };
    const output = wrapResponsesAffinityEgress(frames([
      eventFrame({
        type: 'response.reasoning_summary_text.delta',
        item_id: 'rs_1',
        output_index: 0,
        summary_index: 0,
        delta: 'visible',
      }),
      eventFrame({ type: 'response.output_item.done', output_index: 0, item }),
      eventFrame({ type: 'response.completed', response: response([item]) }),
    ]), { codec, affinity })[Symbol.asyncIterator]();

    expect((await output.next()).value).toMatchObject({
      event: { type: 'response.reasoning_summary_text.delta', delta: 'visible' },
    });
    expect(codec.calls).toHaveLength(0);

    const donePending = output.next();
    await vi.waitFor(() => expect(codec.calls.map(call => call.value)).toEqual(['opaque']));
    codec.calls[0].resolve('wrapped-opaque');
    expect((await donePending).value).toMatchObject({
      event: { item: { encrypted_content: 'wrapped-opaque' } },
    });

    expect((await output.next()).value).toMatchObject({
      event: { response: { output: [{ encrypted_content: 'wrapped-opaque' }] } },
    });
    expect(codec.calls).toHaveLength(1);
  });

  test('caches replacements across added, done, and terminal snapshots', async () => {
    const calls: Array<string | undefined> = [];
    const codec: AffinityEgressCodec = {
      wrap: async value => {
        calls.push(value);
        return `wrapped:${value}`;
      },
    };
    const item: ResponsesOutputReasoning = { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'opaque' };
    const output: ProtocolFrame<ResponsesStreamEvent>[] = [];
    for await (const frame of wrapResponsesAffinityEgress(frames([
      eventFrame({ type: 'response.output_item.added', output_index: 0, item }),
      eventFrame({ type: 'response.output_item.done', output_index: 0, item }),
      eventFrame({ type: 'response.completed', response: response([item]) }),
    ]), { codec, affinity })) output.push(frame);

    expect(calls).toEqual(['opaque']);
    expect(output).toHaveLength(3);
    for (const frame of output) expect(JSON.stringify(frame)).toContain('wrapped:opaque');
  });

  test('injects one synthetic reasoning lifecycle before a carrier-free terminal response', async () => {
    const message = {
      type: 'message' as const,
      id: 'msg_1',
      role: 'assistant' as const,
      status: 'completed',
      content: [{ type: 'output_text' as const, text: 'answer' }],
    };
    const output: ProtocolFrame<ResponsesStreamEvent>[] = [];
    for await (const frame of wrapResponsesAffinityEgress(frames([
      eventFrame({ type: 'response.completed', response: response([message]) }),
    ]), { codec: immediateCodec, affinity })) output.push(frame);

    expect(output.map(frame => frame.type === 'event' ? frame.event.type : frame.type)).toEqual([
      'response.output_item.added',
      'response.output_item.done',
      'response.completed',
    ]);
    const added = output[0];
    const done = output[1];
    if (added.type !== 'event' || added.event.type !== 'response.output_item.added') throw new Error('Expected added event');
    if (done.type !== 'event' || done.event.type !== 'response.output_item.done') throw new Error('Expected done event');
    expect(added.event.item).toEqual(done.event.item);
    expect(added.event.item).toMatchObject({
      type: 'reasoning',
      summary: [],
      encrypted_content: 'wrapped:synthetic',
    });
    expect(output[2]).toMatchObject({ event: { response: { output: [message, added.event.item] } } });
  });

  test('does not synthesize affinity for a failed response', async () => {
    const output: ProtocolFrame<ResponsesStreamEvent>[] = [];
    for await (const frame of wrapResponsesAffinityEgress(frames([
      eventFrame({ type: 'response.failed', response: response([], 'failed') }),
    ]), { codec: immediateCodec, affinity })) output.push(frame);

    expect(output).toEqual([eventFrame({ type: 'response.failed', response: response([], 'failed') })]);
  });

  test('uses the terminal replacement snapshot when deciding whether affinity exists', async () => {
    const early: ResponsesOutputReasoning = { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'early' };
    const final = { type: 'message' as const, id: 'msg_1', role: 'assistant' as const, content: [] };
    const output: ProtocolFrame<ResponsesStreamEvent>[] = [];
    for await (const frame of wrapResponsesAffinityEgress(frames([
      eventFrame({ type: 'response.output_item.added', output_index: 0, item: early }),
      eventFrame({ type: 'response.output_item.done', output_index: 0, item: final }),
      eventFrame({ type: 'response.completed', response: response([final]) }),
    ]), { codec: immediateCodec, affinity })) output.push(frame);

    expect(output.map(frame => frame.type === 'event' ? frame.event.type : frame.type)).toEqual([
      'response.output_item.added',
      'response.output_item.done',
      'response.output_item.added',
      'response.output_item.done',
      'response.completed',
    ]);
  });

  test('adds a force carrier when program state coexists with preferred reasoning', async () => {
    const reasoning: ResponsesOutputReasoning = { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'opaque' };
    const program = { type: 'program' as const, id: 'prog_1', call_id: 'call_1', code: 'return 1', fingerprint: 'fp' };
    const calls: AffinityTarget[] = [];
    const output: ProtocolFrame<ResponsesStreamEvent>[] = [];
    for await (const frame of wrapResponsesAffinityEgress(frames([
      eventFrame({ type: 'response.completed', response: response([reasoning, program]) }),
    ]), {
      codec: {
        wrap: async (_value, target) => {
          calls.push(target);
          return `wrapped:${target.mode}`;
        },
      },
      affinity,
    })) output.push(frame);

    expect(calls.map(call => call.mode)).toEqual(['prefer', 'force']);
    expect(output.map(frame => frame.type === 'event' ? frame.event.type : frame.type)).toEqual([
      'response.output_item.added',
      'response.output_item.done',
      'response.completed',
    ]);
  });
});
