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
    yield doneFrame();
  };
  const events: ResponsesStreamEvent[] = [];

  for await (const frame of normalizeResponsesStreamLifecycle(source())) {
    if (frame.type === 'event') events.push(frame.event);
  }

  assertEquals(events.map(event => event.type), ['response.created', 'response.completed']);
});
