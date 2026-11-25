import { test } from 'vitest';

import { compressImages } from '../../../src/pipelines/openai-responses/compress-images.ts';
import { inspectStages, type StageFixture } from '../inspect.ts';
import { type ImageProcessor, initImageProcessor } from '@floway-dev/platform';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesInputContent, OpenAIResponsesAssistantInputContent, OpenAIResponsesInputImage, CanonicalOpenAIResponsesInputItem, OpenAIResponsesToolOutputContent } from '@floway-dev/protocols/openai-responses';
import { assert, assertEquals, stubProviderModel } from '@floway-dev/test-utils';

const fixedProcessor: ImageProcessor = {
  compressToWebp: () => Promise.resolve(new Uint8Array([1, 2, 3])),
};

const invocation = (payload: CanonicalOpenAIResponsesPayload): StageFixture<'openaiResponses'> => ({
  payload,
  headers: new Headers(),
  model: stubProviderModel({ endpoints: { openaiResponses: {} } }),
});

const contentContainers = {
  message: (content: OpenAIResponsesInputContent[]): CanonicalOpenAIResponsesInputItem => ({ type: 'message', role: 'user', content }),
  function_output: (output: OpenAIResponsesToolOutputContent[]): CanonicalOpenAIResponsesInputItem => ({ type: 'function_call_output', call_id: 'call_function', output }),
};

const imageUrlOf = (item: CanonicalOpenAIResponsesInputItem): string | null | undefined => {
  const content = item.type === 'message'
    ? item.content
    : item.type === 'function_call_output' || item.type === 'custom_tool_call_output' ? item.output : undefined;
  return Array.isArray(content) ? content.find(part => part.type === 'input_image')?.image_url : undefined;
};

const contentOf = (item: CanonicalOpenAIResponsesInputItem): string | OpenAIResponsesAssistantInputContent[] | undefined =>
  item.type === 'message'
    ? item.content
    : item.type === 'function_call_output' || item.type === 'custom_tool_call_output' ? item.output : undefined;

test.each(Object.entries(contentContainers))('compresses inline images in %s', async (_name, wrap) => {
  initImageProcessor(fixedProcessor);
  const textPart = { type: 'input_text' as const, text: 'look' };
  const imagePart: OpenAIResponsesInputImage = { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'auto' };
  const sourceItem = wrap([textPart, imagePart]);
  const untouchedItem: CanonicalOpenAIResponsesInputItem = { type: 'function_call', call_id: 'call_unchanged', name: 'noop', arguments: '{}', status: 'completed' };
  const payload: CanonicalOpenAIResponsesPayload = {
    model: 'gpt-test',
    input: [sourceItem, untouchedItem],
  };
  const fixture = invocation(payload);

  const ctx = await inspectStages('openaiResponses', compressImages('openaiResponses'), fixture);

  assertEquals(imageUrlOf(ctx.payload.input[0]), 'data:image/webp;base64,AQID');
  assertEquals(imageUrlOf(sourceItem), 'data:image/png;base64,AAAA');
  assert(ctx.payload !== payload);
  assert(ctx.payload.input !== payload.input);
  assert(ctx.payload.input[0] !== sourceItem);
  assert(ctx.payload.input[1] === untouchedItem);
  const rewrittenContent = contentOf(ctx.payload.input[0]);
  const sourceContent = contentOf(sourceItem);
  if (!Array.isArray(rewrittenContent) || !Array.isArray(sourceContent)) throw new Error('expected multipart OpenAI Responses content');
  assert(rewrittenContent !== sourceContent);
  assert(rewrittenContent[0] === textPart);
  assert(rewrittenContent[1] !== imagePart);
});

test('compresses each unique inline image only once when the same data URL appears multiple times', async () => {
  let calls = 0;
  initImageProcessor({
    compressToWebp: () => {
      calls += 1;
      return Promise.resolve(new Uint8Array([1, 2, 3]));
    },
  });

  const fixture = invocation({
    model: 'gpt-test',
    input: [
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'auto' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'auto' },
        ],
      },
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'high' }],
      },
      {
        type: 'custom_tool_call_output',
        call_id: 'call_custom',
        output: [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'high' }],
      },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_image', image_url: 'data:image/png;base64,BBBB', detail: 'auto' }],
      },
    ],
  });

  await inspectStages('openaiResponses', compressImages('openaiResponses'), fixture);

  // Two unique data URLs across five targets → exactly two compress calls.
  assertEquals(calls, 2);
});
