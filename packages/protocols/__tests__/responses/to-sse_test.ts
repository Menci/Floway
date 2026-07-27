import { test } from 'vitest';

import type { ResponsesStreamEvent } from '../../src/responses/index.ts';
import { responsesProtocolFrameToSSEFrame } from '../../src/responses/to-sse.ts';
import { eventFrame } from '../../src/common/index.ts';
import { assertEquals } from '@floway-dev/test-utils';

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
        error: null,
        incomplete_details: null,
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
