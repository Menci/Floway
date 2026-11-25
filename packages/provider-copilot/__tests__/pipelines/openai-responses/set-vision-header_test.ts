import { test } from 'vitest';

import { setVisionHeader } from '../../../src/pipelines/openai-responses/set-vision-header.ts';
import { runStage, type StageRequest } from '../stage.ts';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesInputContent, CanonicalOpenAIResponsesInputItem, OpenAIResponsesToolOutputContent } from '@floway-dev/protocols/openai-responses';
import { assertEquals } from '@floway-dev/test-utils';

const requestFor = (payload: CanonicalOpenAIResponsesPayload): StageRequest<'openaiResponses'> => ({
  payload,
  headers: new Headers(),
});

const contentContainers = {
  message: (content: OpenAIResponsesInputContent[]): CanonicalOpenAIResponsesInputItem => ({ type: 'message', role: 'user', content }),
  function_output: (output: OpenAIResponsesToolOutputContent[]): CanonicalOpenAIResponsesInputItem => ({ type: 'function_call_output', call_id: 'call_function', output }),
};

test.each(Object.entries(contentContainers))('OpenAI Responses vision header detects images in %s', async (_name, wrap) => {
  const request = requestFor({
    model: 'gpt-test',
    input: [wrap([
      { type: 'input_text', text: 'look at this' },
      { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'auto' },
    ])],
  });

  const result = await runStage(setVisionHeader, 'openaiResponses', request);

  assertEquals(result.headers.get('copilot-vision-request'), 'true');
});
