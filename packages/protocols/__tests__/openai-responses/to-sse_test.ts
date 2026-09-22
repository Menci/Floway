import { test } from 'vitest';

import { doneFrame, eventFrame } from '../../src/common/index.ts';
import type { OpenAIResponsesStreamEvent } from '../../src/openai-responses/index.ts';
import { openaiResponsesProtocolFrameToSSEFrame } from '../../src/openai-responses/to-sse.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('openaiResponsesProtocolFrameToSSEFrame names each event and renders the terminating frame as the sentinel', () => {
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
    } satisfies OpenAIResponsesStreamEvent),
    eventFrame({
      type: 'response.output_text.delta',
      sequence_number: 1,
      item_id: 'msg_1',
      output_index: 0,
      content_index: 0,
      delta: 'still serialized',
    } satisfies OpenAIResponsesStreamEvent),
    doneFrame(),
  ].map(openaiResponsesProtocolFrameToSSEFrame);

  assertEquals(
    frames.map(frame => frame.event),
    ['response.completed', 'response.output_text.delta', undefined],
  );
  assertEquals(frames[2].data, '[DONE]');
});
