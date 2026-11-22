import { test } from 'vitest';

import { MAX_CONSECUTIVE_WHITESPACE } from '../../../src/stages/shared/whitespace-overflow.ts';
import { fakeCopilotWire, invokeResponses } from '../../pipeline-fixture.ts';
import { doneFrame, eventFrame } from '@floway-dev/protocols/common';
import { assertEquals, sseResponse } from '@floway-dev/test-utils';

test('aborts and emits an error event and done when whitespace exceeds the threshold', async () => {
  const events = ['\n'.repeat(MAX_CONSECUTIVE_WHITESPACE + 1), '\n\n\n'].map(delta => ({
    type: 'response.function_call_arguments.delta',
    item_id: 'fc_0',
    output_index: 0,
    delta,
  }));
  const { provider, model, fetcher } = await fakeCopilotWire('/responses', 'gpt-test', () => sseResponse(
    `${events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')  }data: [DONE]\n\n`,
  ));
  const result = await invokeResponses(provider.pipelines.openaiResponses, model, { input: [] }, 'generate', fetcher);
  assertEquals(result.events, [
    eventFrame({
      type: 'error',
      message: 'Tool call arguments contained excessive whitespace, indicating a degenerate response.',
      code: 'api_error',
    }),
    doneFrame(),
  ]);
});
