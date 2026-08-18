import { test } from 'vitest';

import { withVisionHeaderSet } from '../../../src/interceptors/openai-responses/set-vision-header.ts';
import type { OpenAIResponsesBoundaryCtx } from '../../../src/interceptors/openai-responses/types.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesInputContent, OpenAIResponsesInputItem, OpenAIResponsesStreamEvent, OpenAIResponsesToolOutputContent } from '@floway-dev/protocols/openai-responses';
import type { ExecuteResult } from '@floway-dev/provider';
import { eventResult } from '@floway-dev/provider';
import { assertEquals, stubProviderModel, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const stubRequest = {};

const okEvents = (): Promise<ExecuteResult<ProtocolFrame<OpenAIResponsesStreamEvent>>> =>
  Promise.resolve(eventResult((async function* (): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEvent>> {})(), testTelemetryModelIdentity));

const invocation = (payload: CanonicalOpenAIResponsesPayload): OpenAIResponsesBoundaryCtx => ({
  payload,
  headers: new Headers(),
  model: stubProviderModel({ endpoints: { openaiResponses: {} } }),
  action: 'generate',
});

const contentContainers = {
  message: (content: OpenAIResponsesInputContent[]): OpenAIResponsesInputItem => ({ type: 'message', role: 'user', content }),
  function_output: (output: OpenAIResponsesToolOutputContent[]): OpenAIResponsesInputItem => ({ type: 'function_call_output', call_id: 'call_function', output }),
  custom_output: (output: OpenAIResponsesToolOutputContent[]): OpenAIResponsesInputItem => ({ type: 'custom_tool_call_output', call_id: 'call_custom', output }),
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

test.each(Object.entries(contentContainers))('OpenAI Responses vision header ignores text-only %s', async (_name, wrap) => {
  const ctx = invocation({
    model: 'gpt-test',
    input: [wrap([{ type: 'input_text', text: 'plain text only' }])],
  });

  await withVisionHeaderSet(ctx, stubRequest, okEvents);

  assertEquals(ctx.headers.has('copilot-vision-request'), false);
});
