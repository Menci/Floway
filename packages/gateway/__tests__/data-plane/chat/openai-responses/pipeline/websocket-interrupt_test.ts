import { expect, test } from 'vitest';

import { completeInterruptedOpenAIResponses } from '../../../../../src/data-plane/chat/openai-responses/pipeline/websocket-interrupt.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

test('OpenAI Responses interrupts retention loudly when items or bytes overflow', async () => {
  const frames = async function* (): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEventEx>> {
    yield eventFrame({
      type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'rs_test', summary: [] },
    });
  };
  const options = { signal: new AbortController().signal, responseId: 'resp_test', model: 'model' };
  await expect(Array.fromAsync(completeInterruptedOpenAIResponses(frames(), options, { bytes: 1, items: 10 })))
    .rejects.toThrow('exceeded 1 retained bytes');
  await expect(Array.fromAsync(completeInterruptedOpenAIResponses(frames(), options, { bytes: 4096, items: 0 })))
    .rejects.toThrow('exceeded 0 retained items');
});
