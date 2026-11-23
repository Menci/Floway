import { test } from 'vitest';

import { openAIResponsesStages } from '../../../src/stages/openai-responses/index.ts';
import { inspectRequestStage } from '../../pipeline-fixture.ts';
import { type ImageProcessor, initImageProcessor } from '@floway-dev/platform';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesInputContent, OpenAIResponsesAssistantInputContent, OpenAIResponsesInputImage, CanonicalOpenAIResponsesInputItem, OpenAIResponsesToolOutputContent } from '@floway-dev/protocols/openai-responses';
import { assert, assertEquals } from '@floway-dev/test-utils';

const fixedProcessor: ImageProcessor = {
  compressToWebp: () => Promise.resolve(new Uint8Array([1, 2, 3])),
};

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
  const { payload: rewritten } = await inspectRequestStage(openAIResponsesStages, 'compress-images', payload);

  assertEquals(imageUrlOf(rewritten.input[0]), 'data:image/webp;base64,AQID');
  assertEquals(imageUrlOf(sourceItem), 'data:image/png;base64,AAAA');
  assert(rewritten !== payload);
  assert(rewritten.input !== payload.input);
  assert(rewritten.input[0] !== sourceItem);
  assert(rewritten.input[1] === untouchedItem);
  const rewrittenContent = contentOf(rewritten.input[0]);
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

  const payload: CanonicalOpenAIResponsesPayload = {
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
  };

  await inspectRequestStage(openAIResponsesStages, 'compress-images', payload);

  // Two unique data URLs across five targets → exactly two compress calls.
  assertEquals(calls, 2);
});

test('reuses its compressed image when the same attempt payload is retried', async () => {
  let calls = 0;
  initImageProcessor({
    compressToWebp: () => {
      calls += 1;
      return Promise.resolve(new Uint8Array([1, 2, 3]));
    },
  });

  let payload: CanonicalOpenAIResponsesPayload = {
    model: 'gpt-test',
    input: [{
      type: 'message',
      role: 'user',
      content: [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'auto' }],
    }],
  };

  ({ payload } = await inspectRequestStage(openAIResponsesStages, 'compress-images', payload));
  ({ payload } = await inspectRequestStage(openAIResponsesStages, 'compress-images', payload));

  assertEquals(calls, 1);
  assertEquals(imageUrlOf(payload.input[0]), 'data:image/webp;base64,AQID');

  const item = payload.input[0];
  if (item.type !== 'message' || !Array.isArray(item.content) || item.content[0]?.type !== 'input_image') throw new Error('expected image content');
  const fresh = { ...payload, input: [{ ...item, content: [{ ...item.content[0], image_url: 'data:image/png;base64,BBBB' }] }] };
  await inspectRequestStage(openAIResponsesStages, 'compress-images', fresh);

  assertEquals(calls, 2);
});
