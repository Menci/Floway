import { test } from 'vitest';

import { applyTranslatedAnthropicImageLimits } from '../../../../src/data-plane/chat/openai-responses/anthropic-image-limits.ts';
import { type ImageDimensions, type ImageProcessor, initImageProcessor } from '@floway-dev/platform';
import type { AnthropicMessagesImageBlock, AnthropicMessagesPayload, AnthropicMessagesToolResultBlock, AnthropicMessagesUserMessage } from '@floway-dev/protocols/anthropic-messages';
import { encodeBase64 } from '@floway-dev/protocols/common';
import { assert, assertEquals } from '@floway-dev/test-utils';

const pngHeader = (width: number, height: number): Uint8Array => {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
};

const image = (width: number, height: number): AnthropicMessagesImageBlock => ({
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: encodeBase64(pngHeader(width, height)) },
});

const payload = (content: AnthropicMessagesUserMessage['content']): AnthropicMessagesPayload => ({
  model: 'claude-test',
  max_tokens: 10,
  messages: [{ role: 'user', content }],
});

const spyProcessor = (): { processor: ImageProcessor; inputs: Uint8Array[]; targets: ImageDimensions[] } => {
  const inputs: Uint8Array[] = [];
  const targets: ImageDimensions[] = [];
  return {
    inputs,
    targets,
    processor: {
      compressToWebp(input, target) {
        if (target === null) throw new Error('expected known image dimensions');
        inputs.push(input);
        targets.push(target);
        return Promise.resolve(new Uint8Array([1, 2, 3]));
      },
    },
  };
};

test('limits translated Anthropic requests with more than 20 images to 2000px', async () => {
  const { processor, inputs, targets } = spyProcessor();
  initImageProcessor(processor);
  const smallImages = Array.from({ length: 20 }, () => image(100, 50));
  const oversized = image(2048, 504);
  const toolResult: AnthropicMessagesToolResultBlock = {
    type: 'tool_result',
    tool_use_id: 'toolu_image',
    content: [{ type: 'text', text: 'screenshot' }, oversized],
  };
  const source = payload([...smallImages, toolResult]);
  const sourceContent = source.messages[0].content;

  await applyTranslatedAnthropicImageLimits(source);

  assertEquals(inputs.length, 1);
  assertEquals(targets, [{ width: 2000, height: 492 }]);
  const rewrittenContent = source.messages[0].content;
  if (!Array.isArray(rewrittenContent)) throw new Error('expected user content array');
  assert(rewrittenContent !== sourceContent);
  assert(rewrittenContent[0] === smallImages[0]);
  const rewrittenToolResult = rewrittenContent.at(-1);
  if (rewrittenToolResult?.type !== 'tool_result' || !Array.isArray(rewrittenToolResult.content)) throw new Error('expected tool result');
  const rewrittenImage = rewrittenToolResult.content[1];
  if (rewrittenImage?.type !== 'image') throw new Error('expected nested image');
  assertEquals(rewrittenImage.source, { type: 'base64', media_type: 'image/webp', data: 'AQID' });
  assertEquals(oversized.source.media_type, 'image/png');
});

test('keeps a 2048px image unchanged when the request contains at most 20 images', async () => {
  const { processor, inputs } = spyProcessor();
  initImageProcessor(processor);
  const source = payload([image(2048, 504), ...Array.from({ length: 19 }, () => image(100, 50))]);
  const sourceMessages = source.messages;

  await applyTranslatedAnthropicImageLimits(source);

  assertEquals(inputs.length, 0);
  assert(source.messages === sourceMessages);
});

test('limits ordinary translated Anthropic images to 8000px', async () => {
  const { processor, targets } = spyProcessor();
  initImageProcessor(processor);
  const source = payload([image(9000, 4500)]);

  await applyTranslatedAnthropicImageLimits(source);

  assertEquals(targets, [{ width: 8000, height: 4000 }]);
});

test('compresses duplicate oversized images once per translated request', async () => {
  const { processor, inputs } = spyProcessor();
  initImageProcessor(processor);
  const repeated = image(2048, 504);
  const content = Array.from({ length: 21 }, () => ({
    ...repeated,
    source: { ...repeated.source },
  }));
  const source = payload(content);

  await applyTranslatedAnthropicImageLimits(source);

  assertEquals(inputs.length, 1);
  const rewritten = source.messages[0].content;
  if (!Array.isArray(rewritten) || rewritten.some(block => block.type !== 'image')) throw new Error('expected image blocks');
  assert(rewritten.every(block => block.type === 'image' && block.source.media_type === 'image/webp'));
});

test('leaves malformed image data for Anthropic validation', async () => {
  const { processor, inputs } = spyProcessor();
  initImageProcessor(processor);
  const malformed: AnthropicMessagesImageBlock = {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: 'not base64' },
  };
  const source = payload([malformed]);
  const sourceMessages = source.messages;

  await applyTranslatedAnthropicImageLimits(source);

  assertEquals(inputs.length, 0);
  assert(source.messages === sourceMessages);
});
