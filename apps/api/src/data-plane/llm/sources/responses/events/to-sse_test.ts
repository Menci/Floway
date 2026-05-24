import { test } from 'vitest';

import { responsesProtocolFrameToSSEFrame } from './to-sse.ts';
import { assertEquals } from '../../../../../test-assert.ts';
import { eventFrame } from '@floway-dev/protocols/common';
import type { ResponsesStreamEvent } from '@floway-dev/protocols/responses';

test('responsesProtocolFrameToSSEFrame serializes events without owning termination', () => {
  const frames = [
    eventFrame({
      type: 'response.completed',
      sequence_number: 0,
      response: {
        id: 'resp_done',
        object: 'response',
        model: 'gpt-test',
        status: 'completed',
        output: [],
        output_text: '',
      },
    } satisfies ResponsesStreamEvent),
    eventFrame({
      type: 'response.output_text.delta',
      sequence_number: 1,
      item_id: 'msg_1',
      output_index: 0,
      content_index: 0,
      delta: 'still serialized',
    } satisfies ResponsesStreamEvent),
  ].map(responsesProtocolFrameToSSEFrame);

  assertEquals(
    frames.map(frame => frame?.event),
    ['response.completed', 'response.output_text.delta'],
  );
});
