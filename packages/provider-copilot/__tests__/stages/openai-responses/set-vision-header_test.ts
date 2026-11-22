import { test } from 'vitest';

import { copilotOpenAIResponsesHasImage } from '../../../src/stages/openai-responses/set-vision-header.ts';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesInputContent, CanonicalOpenAIResponsesInputItem, OpenAIResponsesToolOutputContent } from '@floway-dev/protocols/openai-responses';
import { assertEquals } from '@floway-dev/test-utils';

const contentContainers = {
  message: (content: OpenAIResponsesInputContent[]): CanonicalOpenAIResponsesInputItem => ({ type: 'message', role: 'user', content }),
  function_output: (output: OpenAIResponsesToolOutputContent[]): CanonicalOpenAIResponsesInputItem => ({ type: 'function_call_output', call_id: 'call_function', output }),
};

test.each(Object.entries(contentContainers))('OpenAI Responses vision header detects images in %s', async (_name, wrap) => {
  const payload: CanonicalOpenAIResponsesPayload = {
    model: 'gpt-test',
    input: [wrap([
      { type: 'input_text', text: 'look at this' },
      { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'auto' },
    ])],
  };

  assertEquals(copilotOpenAIResponsesHasImage(payload), true);
});
