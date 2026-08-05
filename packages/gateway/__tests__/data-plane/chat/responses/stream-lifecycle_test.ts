import { test } from 'vitest';

import { normalizeResponsesStreamLifecycle } from '../../../../src/data-plane/chat/responses/stream-lifecycle.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesResult, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import { assertEquals } from '@floway-dev/test-utils';

test('an upstream error without response.failed is closed with a failed response before the sentinel', async () => {
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
  const events: ResponsesStreamEvent[] = [];

  for await (const frame of normalizeResponsesStreamLifecycle(source())) {
    if (frame.type === 'event') events.push(frame.event);
  }

  assertEquals(events.map(event => event.type), ['response.created', 'error', 'response.failed']);
  const failed = events[2];
  if (failed?.type !== 'response.failed') throw new Error('expected a synthesized response.failed');
  assertEquals(failed.sequence_number, 2);
  assertEquals(failed.response.status, 'failed');
  assertEquals(failed.response.error, { code: 'overloaded', message: 'try later' });
});

test('returning after a response terminal still drains the upstream sentinel', async () => {
  const created: ResponsesResult = {
    id: 'resp_upstream',
    object: 'response',
    model: 'model',
    status: 'in_progress',
    output: [],
    error: null,
    incomplete_details: null,
  };
  let sentinelDrained = false;
  const source = async function* (): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
    yield eventFrame({ type: 'response.created', sequence_number: 0, response: created });
    yield eventFrame({
      type: 'response.completed',
      sequence_number: 1,
      response: { ...created, status: 'completed' },
    });
    yield doneFrame();
    sentinelDrained = true;
  };
  const normalized = normalizeResponsesStreamLifecycle(source())[Symbol.asyncIterator]();

  const createdFrame = await normalized.next();
  const completedFrame = await normalized.next();
  await normalized.return(undefined);

  assertEquals(createdFrame.value?.type === 'event' ? createdFrame.value.event.type : undefined, 'response.created');
  assertEquals(completedFrame.value?.type === 'event' ? completedFrame.value.event.type : undefined, 'response.completed');
  assertEquals(sentinelDrained, true);
});
