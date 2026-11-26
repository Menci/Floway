import { test } from 'vitest';

import { withVisionHeaderSet } from '../../../src/interceptors/openai-responses/set-vision-header.ts';
import type { OpenAIResponsesBoundaryCtx } from '../../../src/interceptors/openai-responses/types.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesInputContent, CanonicalOpenAIResponsesInputItem, OpenAIResponsesStreamEventEx, OpenAIResponsesToolOutputContent } from '@floway-dev/protocols/openai-responses';
import { assertEquals, stubUpstreamModel, testTelemetryModelIdentity } from '@floway-dev/test-utils';
import type { ExecuteResult } from '@floway-dev/upstream';
import { eventResult } from '@floway-dev/upstream';

const stubRequest = {};

const okEvents = (): Promise<ExecuteResult<ProtocolFrame<OpenAIResponsesStreamEventEx>>> =>
  Promise.resolve(eventResult((async function* (): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEventEx>> {})(), testTelemetryModelIdentity));

const invocation = (payload: CanonicalOpenAIResponsesPayload): OpenAIResponsesBoundaryCtx => ({
  payload,
  headers: new Headers(),
  model: stubUpstreamModel({ endpoints: { openaiResponses: {} } }),
  action: 'generate',
});

const contentContainers = {
  message: (content: OpenAIResponsesInputContent[]): CanonicalOpenAIResponsesInputItem => ({ type: 'message', role: 'user', content }),
  function_output: (output: OpenAIResponsesToolOutputContent[]): CanonicalOpenAIResponsesInputItem => ({ type: 'function_call_output', call_id: 'call_function', output }),
};

test.each(Object.entries(contentContainers))('OpenAI Responses vision header detects images in %s', async (_name, wrap) => {
  const ctx = invocation({
    model: 'gpt-test',
    input: [wrap([
      { type: 'input_text', text: 'look at this' },
      { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'auto' },
    ])],
  });

  await withVisionHeaderSet(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers.get('copilot-vision-request'), 'true');
});
