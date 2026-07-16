import { describe, expect, test, vi } from 'vitest';

import { wrapResponsesAffinityEgress } from './egress.ts';
import type { AffinityCodec, AffinityTarget } from '../../shared/affinity/index.ts';
import { hashResponsesItemBinding } from '../items/format.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesOutputItem, ResponsesOutputReasoning, ResponsesResult, ResponsesStreamEvent } from '@floway-dev/protocols/responses';

const affinity: AffinityTarget = {
  upstreamId: 'up-a',
  modelId: 'model-a',
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
    expect(added.event.item).not.toHaveProperty('encrypted_content');
    expect(done.event.item).toMatchObject({
      type: 'reasoning',
      summary: [],
      encrypted_content: 'wrapped:synthetic',
    });
    expect(output[2]).toMatchObject({ event: { response: { output: [done.event.item, message] } } });
  });

  test('does not synthesize affinity for a failed response', async () => {
    const output: ProtocolFrame<ResponsesStreamEvent>[] = [];
    for await (const frame of wrapResponsesAffinityEgress(frames([
      eventFrame({ type: 'response.failed', response: response([], 'failed') }),
    ]), { codec: immediateCodec, affinity })) output.push(frame);

    expect(output).toEqual([eventFrame({ type: 'response.failed', response: response([], 'failed') })]);
  });

  test('does not synthesize a missing program carrier in a failed snapshot', async () => {
    const program = { type: 'program', id: 'prog_1', call_id: 'call_1', code: 'return 1' } as ResponsesOutputItem;
    const output: ProtocolFrame<ResponsesStreamEvent>[] = [];
    for await (const frame of wrapResponsesAffinityEgress(frames([
      eventFrame({ type: 'response.failed', response: response([program], 'failed') }),
    ]), { codec: immediateCodec, affinity })) output.push(frame);

    expect(output).toEqual([eventFrame({ type: 'response.failed', response: response([program], 'failed') })]);
  });

  test('adds one synthetic carrier to a real first reasoning item at item close', async () => {
    const reasoning: ResponsesOutputReasoning = { type: 'reasoning', id: 'rs_1', summary: [] };
    const output: ProtocolFrame<ResponsesStreamEvent>[] = [];
    for await (const frame of wrapResponsesAffinityEgress(frames([
      eventFrame({ type: 'response.output_item.added', output_index: 0, item: reasoning }),
      eventFrame({ type: 'response.output_item.done', output_index: 0, item: reasoning }),
      eventFrame({ type: 'response.completed', response: response([reasoning]) }),
    ]), { codec: immediateCodec, affinity })) output.push(frame);

    expect(output).toHaveLength(3);
    expect(output[0]).not.toMatchObject({ event: { item: { encrypted_content: expect.anything() } } });
    expect(output[1]).toMatchObject({ event: { item: { encrypted_content: 'wrapped:synthetic' } } });
    expect(output[2]).toMatchObject({ event: { response: { output: [{ encrypted_content: 'wrapped:synthetic' }] } } });
  });

  test('keeps force policy out of the encrypted natural carrier', async () => {
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
          return `wrapped:${target.syntheticItem === true ? 'synthetic' : 'natural'}`;
        },
      },
      affinity,
    })) output.push(frame);

    expect(calls.map(call => call.syntheticItem === true)).toEqual([false, false]);
    expect(output).toHaveLength(1);
  });

  test('waits for a program fingerprint before deciding whether it needs a prefix', async () => {
    const added = { type: 'program', id: 'prog_1', call_id: 'call_1', code: 'return 1' } as ResponsesOutputItem;
    const done = { ...added, fingerprint: 'fp' } as ResponsesOutputItem;
    const output: ProtocolFrame<ResponsesStreamEvent>[] = [];
    for await (const frame of wrapResponsesAffinityEgress(frames([
      eventFrame({ type: 'response.output_item.added', output_index: 0, item: added }),
      eventFrame({ type: 'response.in_progress', response: response([added], 'in_progress') }),
      eventFrame({ type: 'response.output_item.done', output_index: 0, item: done }),
      eventFrame({ type: 'response.completed', response: response([done]) }),
    ]), { codec: immediateCodec, affinity })) output.push(frame);

    expect(output).toHaveLength(4);
    expect(JSON.stringify(output)).not.toContain('"type":"reasoning"');
    expect(output[1]).not.toMatchObject({ event: { response: { output: [{ fingerprint: expect.anything() }] } } });
    expect(output[2]).toMatchObject({ event: { item: { type: 'program', fingerprint: 'wrapped:fp' } } });
    expect(output[3]).toMatchObject({ event: { response: { output: [{ type: 'program', fingerprint: 'wrapped:fp' }] } } });
  });

  test('uses the program fingerprint slot for a synthetic carrier at close', async () => {
    const program = { type: 'program', id: 'prog_1', call_id: 'call_1', code: 'return 1' } as ResponsesOutputItem;
    const output: ProtocolFrame<ResponsesStreamEvent>[] = [];
    for await (const frame of wrapResponsesAffinityEgress(frames([
      eventFrame({ type: 'response.output_item.added', output_index: 0, item: program }),
      eventFrame({ type: 'response.output_item.done', output_index: 0, item: program }),
      eventFrame({ type: 'response.completed', response: response([program]) }),
    ]), { codec: immediateCodec, affinity })) output.push(frame);

    expect(output).toHaveLength(3);
    expect(JSON.stringify(output)).not.toContain('"type":"reasoning"');
    expect(output[0]).not.toMatchObject({ event: { item: { fingerprint: expect.anything() } } });
    expect(output[1]).toMatchObject({ event: { item: { fingerprint: 'wrapped:synthetic' } } });
    expect(output[2]).toMatchObject({ event: { response: { output: [{ fingerprint: 'wrapped:synthetic' }] } } });
  });

  test('prefixes a non-carrier item and shifts output and sequence indexes', async () => {
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
      ['response.output_item.added', 3],
      ['response.output_text.delta', 4],
      ['response.output_item.done', 5],
      ['response.output_item.done', 6],
      ['response.completed', 7],
    ]);
    expect(output[1]).toMatchObject({ event: { output_index: 1 } });
    expect(output[2]).toMatchObject({ event: { output_index: 1 } });
    expect(output[3]).toMatchObject({ event: { output_index: 0, item: { encrypted_content: 'wrapped:synthetic' } } });
    expect(output[4]).toMatchObject({ event: { output_index: 1 } });
    expect(output[5]).toMatchObject({ event: { response: { output: [{ type: 'reasoning' }, message] } } });
  });

  test('keeps an earlier open item on its lifecycle index after a later insertion', async () => {
    const message = {
      type: 'message' as const,
      id: 'msg_1',
      role: 'assistant' as const,
      status: 'completed',
      content: [{ type: 'output_text' as const, text: 'answer' }],
    };
    const programOutput = { type: 'program_output' as const, id: 'prog_out_1', call_id: 'call_1', result: 'done', status: 'completed' as const };
    const output: ProtocolFrame<ResponsesStreamEvent>[] = [];
    for await (const frame of wrapResponsesAffinityEgress(frames([
      eventFrame({ type: 'response.output_item.added', output_index: 0, item: message, sequence_number: 0 }),
      eventFrame({ type: 'response.output_item.added', output_index: 1, item: programOutput, sequence_number: 1 }),
      eventFrame({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'answer', sequence_number: 2 }),
      eventFrame({ type: 'response.output_item.done', output_index: 0, item: message, sequence_number: 3 }),
      eventFrame({ type: 'response.output_item.done', output_index: 1, item: programOutput, sequence_number: 4 }),
      eventFrame({ type: 'response.completed', response: response([message, programOutput]), sequence_number: 5 }),
    ]), { codec: immediateCodec, affinity })) output.push(frame);

    const delta = output.find(frame => frame.type === 'event' && frame.event.type === 'response.output_text.delta');
    const messageDone = output.find(frame =>
      frame.type === 'event'
      && frame.event.type === 'response.output_item.done'
      && frame.event.item.type === 'message');
    expect(delta).toMatchObject({ event: { output_index: 1 } });
    expect(messageDone).toMatchObject({ event: { output_index: 1 } });
    expect(output.at(-1)).toMatchObject({
      event: { response: { output: [{ type: 'reasoning' }, message, { type: 'reasoning' }, programOutput] } },
    });
  });

  test('discovers the first prefix from an in-progress snapshot before item added', async () => {
    const message = {
      type: 'message' as const,
      id: 'msg_1',
      role: 'assistant' as const,
      status: 'completed',
      content: [{ type: 'output_text' as const, text: 'answer' }],
    };
    const output: ProtocolFrame<ResponsesStreamEvent>[] = [];
    for await (const frame of wrapResponsesAffinityEgress(frames([
      eventFrame({ type: 'response.in_progress', response: response([message], 'in_progress'), sequence_number: 0 }),
      eventFrame({ type: 'response.output_item.added', output_index: 0, item: message, sequence_number: 1 }),
      eventFrame({ type: 'response.output_item.done', output_index: 0, item: message, sequence_number: 2 }),
      eventFrame({ type: 'response.completed', response: response([message]), sequence_number: 3 }),
    ]), { codec: immediateCodec, affinity })) output.push(frame);

    const inProgress = output.find(frame => frame.type === 'event' && frame.event.type === 'response.in_progress');
    const added = output.find(frame =>
      frame.type === 'event'
      && frame.event.type === 'response.output_item.added'
      && frame.event.item.type === 'message');
    expect(inProgress).toMatchObject({ event: { response: { output: [{ type: 'reasoning' }, message] } } });
    expect(added).toMatchObject({ event: { output_index: 1, item: message } });
  });

  test('discovers a later bound prefix from an in-progress snapshot before item added', async () => {
    const reasoning: ResponsesOutputReasoning = { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'opaque' };
    const programOutput = { type: 'program_output' as const, id: 'prog_out_1', call_id: 'call_1', result: 'done', status: 'completed' as const };
    const output: ProtocolFrame<ResponsesStreamEvent>[] = [];
    for await (const frame of wrapResponsesAffinityEgress(frames([
      eventFrame({ type: 'response.in_progress', response: response([reasoning, programOutput], 'in_progress'), sequence_number: 0 }),
      eventFrame({ type: 'response.output_item.added', output_index: 1, item: programOutput, sequence_number: 1 }),
      eventFrame({ type: 'response.output_item.done', output_index: 1, item: programOutput, sequence_number: 2 }),
      eventFrame({ type: 'response.completed', response: response([reasoning, programOutput]), sequence_number: 3 }),
    ]), { codec: immediateCodec, affinity })) output.push(frame);

    const inProgress = output.find(frame => frame.type === 'event' && frame.event.type === 'response.in_progress');
    const added = output.find(frame =>
      frame.type === 'event'
      && frame.event.type === 'response.output_item.added'
      && frame.event.item.type === 'program_output');
    expect(inProgress).toMatchObject({
      event: { response: { output: [{ type: 'reasoning' }, { type: 'reasoning' }, programOutput] } },
    });
    expect(added).toMatchObject({ event: { output_index: 2, item: programOutput } });
  });

  test('binds a prefixed item from its canonical done snapshot', async () => {
    const addedItem = { type: 'program_output' as const, id: 'initial_upstream', call_id: 'call_1', result: '', status: 'incomplete' as const };
    const doneItem = { type: 'program_output' as const, id: 'final_upstream', call_id: 'call_1', result: 'done', status: 'completed' as const };
    const calls: AffinityTarget[] = [];
    const output: ProtocolFrame<ResponsesStreamEvent>[] = [];
    for await (const frame of wrapResponsesAffinityEgress(frames([
      eventFrame({ type: 'response.output_item.added', output_index: 0, item: addedItem }),
      eventFrame({ type: 'response.output_item.done', output_index: 0, item: doneItem }),
      eventFrame({ type: 'response.completed', response: response([doneItem]) }),
    ]), {
      codec: {
        wrap: async (_value, target) => {
          calls.push(target);
          return 'wrapped';
        },
      },
      affinity,
    })) output.push(frame);

    expect(calls).toContainEqual({
      ...affinity,
      syntheticItem: true,
      boundItem: {
        type: 'program_output',
        upstreamItemId: 'final_upstream',
        contentHash: await hashResponsesItemBinding(doneItem),
      },
    });
    expect(output.map(frame => frame.type === 'event' ? frame.event.type : frame.type)).toEqual([
      'response.output_item.added',
      'response.output_item.added',
      'response.output_item.done',
      'response.output_item.done',
      'response.completed',
    ]);
    expect(output[4]).toMatchObject({ event: { response: { output: [{ encrypted_content: 'wrapped' }, doneItem] } } });
  });

  test('binds a prefixed force item to its original upstream ID', async () => {
    const programOutput = { type: 'program_output' as const, id: 'prog_out_upstream', call_id: 'call_1', result: 'done', status: 'completed' as const };
    const calls: AffinityTarget[] = [];
    const output: ProtocolFrame<ResponsesStreamEvent>[] = [];
    for await (const frame of wrapResponsesAffinityEgress(frames([
      eventFrame({ type: 'response.completed', response: response([programOutput]) }),
    ]), {
      codec: {
        wrap: async (_value, target) => {
          calls.push(target);
          return 'wrapped';
        },
      },
      affinity,
    })) output.push(frame);

    expect(calls).toContainEqual({
      ...affinity,
      syntheticItem: true,
      boundItem: {
        type: 'program_output',
        upstreamItemId: 'prog_out_upstream',
        contentHash: await hashResponsesItemBinding(programOutput),
      },
    });
    expect(output).toHaveLength(3);
  });

  test('wraps compaction_summary as a natural carrier without inserting a prefix', async () => {
    const item = { type: 'compaction_summary', id: 'cmp_upstream', encrypted_content: 'opaque' } as unknown as ResponsesOutputItem;
    const values: Array<string | undefined> = [];
    const output: ProtocolFrame<ResponsesStreamEvent>[] = [];
    for await (const frame of wrapResponsesAffinityEgress(frames([
      eventFrame({ type: 'response.completed', response: response([item]) }),
    ]), {
      codec: { wrap: async value => { values.push(value); return 'wrapped'; } },
      affinity,
    })) output.push(frame);

    expect(values).toEqual(['opaque']);
    expect(output).toHaveLength(1);
    expect(output[0]).toMatchObject({ event: { response: { output: [{ type: 'compaction_summary', encrypted_content: 'wrapped' }] } } });
  });
});
