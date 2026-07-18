import { describe, expect, test, vi } from 'vitest';

import { wrapResponsesAffinityEgress } from './egress.ts';
import type { AffinityCodec, AffinityTarget } from '../../shared/affinity/index.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesOutputItem, ResponsesOutputReasoning, ResponsesResult, ResponsesStreamEvent } from '@floway-dev/protocols/responses';

const affinity: AffinityTarget = { upstreamId: 'up-a', modelId: 'model-a' };
type AffinityEgressCodec = Pick<AffinityCodec, 'wrap'>;

const frames = async function* (values: ProtocolFrame<ResponsesStreamEvent>[]) {
  yield* values;
};

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
  test('streams visible reasoning before wrapping and reuses one natural carrier', async () => {
    const calls: Array<{ value: string | undefined; resolve: (value: string) => void }> = [];
    const codec: AffinityEgressCodec = {
      wrap: value => new Promise(resolve => calls.push({ value, resolve })),
    };
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

    expect((await output.next()).value).toMatchObject({ event: { delta: 'visible' } });
    expect(calls).toHaveLength(0);
    const pending = output.next();
    await vi.waitFor(() => expect(calls.map(call => call.value)).toEqual(['opaque']));
    calls[0].resolve('wrapped:opaque');
    expect((await pending).value).toMatchObject({ event: { item: { encrypted_content: 'wrapped:opaque' } } });
    expect((await output.next()).value).toMatchObject({
      event: { response: { output: [{ encrypted_content: 'wrapped:opaque' }] } },
    });
    expect(calls).toHaveLength(1);
  });

  test('emits a complete reasoning prefix before a non-carrier first item', async () => {
    const message = {
      type: 'message' as const,
      id: 'msg_1',
      role: 'assistant' as const,
      status: 'completed',
      content: [{ type: 'output_text' as const, text: 'answer' }],
    };
    const output: ProtocolFrame<ResponsesStreamEvent>[] = [];
    for await (const frame of wrapResponsesAffinityEgress(frames([
      eventFrame({ type: 'response.output_item.added', output_index: 0, item: message, sequence_number: 2 }),
      eventFrame({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'answer', sequence_number: 3 }),
      eventFrame({ type: 'response.output_item.done', output_index: 0, item: message, sequence_number: 4 }),
      eventFrame({ type: 'response.completed', response: response([message]), sequence_number: 5 }),
    ]), { codec: immediateCodec, affinity })) output.push(frame);

    expect(output.map(frame => frame.type === 'event' ? [frame.event.type, frame.event.sequence_number] : [frame.type])).toEqual([
      ['response.output_item.added', 2],
      ['response.output_item.done', 3],
      ['response.output_item.added', 4],
      ['response.output_text.delta', 5],
      ['response.output_item.done', 6],
      ['response.completed', 7],
    ]);
    expect(output[0]).toMatchObject({ event: { output_index: 0, item: { type: 'reasoning' } } });
    expect(output[1]).toMatchObject({
      event: { output_index: 0, item: { type: 'reasoning', encrypted_content: 'wrapped:synthetic' } },
    });
    expect(output[2]).toMatchObject({ event: { output_index: 1, item: message } });
    expect(output[5]).toMatchObject({ event: { response: { output: [{ type: 'reasoning' }, message] } } });
  });

  test('adds an originless carrier to a carrier-capable first item at close', async () => {
    const program = { type: 'program', id: 'prog_1', call_id: 'call_1', code: 'return 1' } as ResponsesOutputItem;
    const output: ProtocolFrame<ResponsesStreamEvent>[] = [];
    for await (const frame of wrapResponsesAffinityEgress(frames([
      eventFrame({ type: 'response.output_item.added', output_index: 0, item: program }),
      eventFrame({ type: 'response.output_item.done', output_index: 0, item: program }),
      eventFrame({ type: 'response.completed', response: response([program]) }),
    ]), { codec: immediateCodec, affinity })) output.push(frame);

    expect(output).toHaveLength(3);
    expect(output[0]).not.toMatchObject({ event: { item: { fingerprint: expect.anything() } } });
    expect(output[1]).toMatchObject({ event: { item: { fingerprint: 'wrapped:synthetic' } } });
    expect(output[2]).toMatchObject({ event: { response: { output: [{ fingerprint: 'wrapped:synthetic' }] } } });
  });

  test('does not synthesize carriers for later program items', async () => {
    const reasoning: ResponsesOutputReasoning = {
      type: 'reasoning',
      id: 'rs_1',
      summary: [],
      encrypted_content: 'opaque',
    };
    const program = { type: 'program', id: 'prog_1', call_id: 'call_1', code: 'return 1' } as ResponsesOutputItem;
    const programOutput = { type: 'program_output', id: 'prog_out_1', call_id: 'call_1', result: 'done', status: 'completed' } as ResponsesOutputItem;
    const output: ProtocolFrame<ResponsesStreamEvent>[] = [];
    for await (const frame of wrapResponsesAffinityEgress(frames([
      eventFrame({ type: 'response.completed', response: response([reasoning, program, programOutput]) }),
    ]), { codec: immediateCodec, affinity })) output.push(frame);

    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({
      event: {
        response: {
          output: [
            { encrypted_content: 'wrapped:opaque' },
            { type: 'program' },
            { type: 'program_output' },
          ],
        },
      },
    });
  });

  test('injects one complete prefix for a non-streaming terminal response', async () => {
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
    expect(output[2]).toMatchObject({ event: { response: { output: [{ type: 'reasoning' }, message] } } });
  });

  test('does not synthesize affinity for a failed response', async () => {
    const output: ProtocolFrame<ResponsesStreamEvent>[] = [];
    for await (const frame of wrapResponsesAffinityEgress(frames([
      eventFrame({ type: 'response.failed', response: response([], 'failed') }),
    ]), { codec: immediateCodec, affinity })) output.push(frame);

    expect(output).toEqual([eventFrame({ type: 'response.failed', response: response([], 'failed') })]);
  });

  test('wraps compaction_summary as a natural carrier without inserting a prefix', async () => {
    const item = { type: 'compaction_summary', id: 'cmp_upstream', encrypted_content: 'opaque' } as unknown as ResponsesOutputItem;
    const output: ProtocolFrame<ResponsesStreamEvent>[] = [];
    for await (const frame of wrapResponsesAffinityEgress(frames([
      eventFrame({ type: 'response.completed', response: response([item]) }),
    ]), { codec: immediateCodec, affinity })) output.push(frame);

    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({
      event: { response: { output: [{ type: 'compaction_summary', encrypted_content: 'wrapped:opaque' }] } },
    });
  });
});
