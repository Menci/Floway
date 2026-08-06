import { expect, test } from 'vitest';

import { normalizeResponsesStreamLifecycle } from '../../../../src/data-plane/chat/responses/stream-lifecycle.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesResult, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import { assertEquals } from '@floway-dev/test-utils';

const visibleFrameTypes = (frames: readonly ProtocolFrame<ResponsesStreamEvent>[]): string[] =>
  frames.map(frame => frame.type === 'event' ? frame.event.type : frame.type);

test('an upstream error without response.failed is closed without exposing the transport sentinel', async () => {
  const created: ResponsesResult = {
    id: 'resp_upstream',
    object: 'response',
    model: 'model',
    status: 'in_progress',
    output: [],
    error: null,
    incomplete_details: null,
  };
  const source = async function* (): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
    yield eventFrame({ type: 'response.created', sequence_number: 0, response: created });
    yield eventFrame({ type: 'error', sequence_number: 1, code: 'overloaded', message: 'try later' });
    yield doneFrame();
  };
  const frames: ProtocolFrame<ResponsesStreamEvent>[] = [];

  for await (const frame of normalizeResponsesStreamLifecycle(source())) {
    frames.push(frame);
  }

  assertEquals(visibleFrameTypes(frames), ['response.created', 'error', 'response.failed']);
  const failedFrame = frames[2];
  const failed = failedFrame?.type === 'event' ? failedFrame.event : undefined;
  if (failed?.type !== 'response.failed') throw new Error('expected a synthesized response.failed');
  assertEquals(failed.sequence_number, 2);
  assertEquals(failed.response.status, 'failed');
  assertEquals(failed.response.error, { code: 'overloaded', message: 'try later' });
});

test('a response terminal remains the last visible frame', async () => {
  const created: ResponsesResult = {
    id: 'resp_upstream',
    object: 'response',
    model: 'model',
    status: 'in_progress',
    output: [],
    error: null,
    incomplete_details: null,
  };
  const source = async function* (): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
    yield eventFrame({ type: 'response.created', sequence_number: 0, response: created });
    yield eventFrame({
      type: 'response.completed',
      sequence_number: 1,
      response: { ...created, status: 'completed' },
    });
    yield eventFrame({ type: 'response.output_text.delta', sequence_number: 2, item_id: 'item', output_index: 0, content_index: 0, delta: 'late', logprobs: [] });
    yield doneFrame();
  };
  const frames: ProtocolFrame<ResponsesStreamEvent>[] = [];

  for await (const frame of normalizeResponsesStreamLifecycle(source())) {
    frames.push(frame);
  }

  assertEquals(visibleFrameTypes(frames), ['response.created', 'response.completed']);
});

for (const terminalType of ['response.completed', 'response.incomplete'] as const) {
  test(`an upstream error converts a contradictory ${terminalType} into response.failed`, async () => {
    const created: ResponsesResult = {
      id: 'resp_contradictory', object: 'response', model: 'model', status: 'in_progress',
      output: [], error: null, incomplete_details: null,
    };
    const terminalStatus = terminalType === 'response.completed' ? 'completed' : 'incomplete';
    const source = async function* (): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
      yield eventFrame({ type: 'response.created', sequence_number: 0, response: created });
      yield eventFrame({ type: 'error', sequence_number: 1, code: 'overloaded', message: 'try later' });
      yield eventFrame({
        type: terminalType,
        sequence_number: 2,
        response: { ...created, status: terminalStatus },
      } as ResponsesStreamEvent);
      yield doneFrame();
    };
    const frames: ProtocolFrame<ResponsesStreamEvent>[] = [];

    for await (const frame of normalizeResponsesStreamLifecycle(source())) {
      frames.push(frame);
    }

    assertEquals(visibleFrameTypes(frames), ['response.created', 'error', 'response.failed']);
    const failedFrame = frames[2];
    const failed = failedFrame?.type === 'event' ? failedFrame.event : undefined;
    if (failed?.type !== 'response.failed') throw new Error('expected response.failed');
    assertEquals(failed.response.status, 'failed');
    assertEquals(failed.response.error, { code: 'overloaded', message: 'try later' });
  });
}

test('synthesized response.failed rejects exhausted sequence space', async () => {
  const created: ResponsesResult = {
    id: 'resp_sequence', object: 'response', model: 'model', status: 'in_progress',
    output: [], error: null, incomplete_details: null,
  };
  const source = async function* (): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
    yield eventFrame({ type: 'response.created', sequence_number: Number.MAX_SAFE_INTEGER - 1, response: created });
    yield eventFrame({ type: 'error', sequence_number: Number.MAX_SAFE_INTEGER, code: 'overloaded', message: 'try later' });
    yield doneFrame();
  };

  await expect(async () => {
    for await (const _frame of normalizeResponsesStreamLifecycle(source())) { /* drain */ }
  }).rejects.toThrow(/sequence_number space exhausted/);
});
