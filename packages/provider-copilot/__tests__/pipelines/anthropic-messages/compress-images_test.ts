import { test } from 'vitest';

import { compressImages } from '../../../src/pipelines/anthropic-messages/compress-images.ts';
import { runStage, type StageRequest } from '../stage.ts';
import { type ImageDimensions, type ImageProcessor, initImageProcessor } from '@floway-dev/platform';
import type { AnthropicMessagesImageBlock, AnthropicMessagesPayload, AnthropicMessagesToolResultBlock } from '@floway-dev/protocols/anthropic-messages';
import { assert, assertEquals, stubProviderModel } from '@floway-dev/test-utils';

// Records the bytes and resolved target dimensions handed to the processor and
// returns a fixed [1,2,3] WebP payload, which base64-encodes to "AQID".
const spyProcessor = (): { processor: ImageProcessor; inputs: Uint8Array[]; targets: (ImageDimensions | null)[] } => {
  const inputs: Uint8Array[] = [];
  const targets: (ImageDimensions | null)[] = [];
  const processor: ImageProcessor = {
    compressToWebp(input, target) {
      inputs.push(input);
      targets.push(target);
      return Promise.resolve(new Uint8Array([1, 2, 3]));
    },
  };
  return { processor, inputs, targets };
};

const requestFor = (payload: AnthropicMessagesPayload, upstreamModelId = 'claude-test'): StageRequest<'anthropicMessages'> => ({
  payload,
  headers: new Headers(),
  model: stubProviderModel({ id: upstreamModelId, endpoints: { anthropicMessages: {} } }),
});

test('compresses an image nested inside tool_result content', async () => {
  const { processor } = spyProcessor();
  initImageProcessor(processor);

  const outerText = { type: 'text' as const, text: 'before tool result' };
  const innerText = { type: 'text' as const, text: 'screenshot' };
  const nestedImage: AnthropicMessagesImageBlock = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };
  const toolResult: AnthropicMessagesToolResultBlock = {
    type: 'tool_result',
    tool_use_id: 'toolu_image',
    content: [innerText, nestedImage],
  };
  const untouchedMessage = { role: 'system' as const, content: 'unchanged' };
  const payload: AnthropicMessagesPayload = {
    model: 'claude-test',
    max_tokens: 10,
    messages: [
      {
        role: 'user',
        content: [
          outerText,
          toolResult,
        ],
      },
      untouchedMessage,
    ],
  };
  const request = requestFor(payload);

  const result = await runStage(compressImages, 'anthropicMessages', request);

  const rewrittenContent = result.payload.messages[0].content;
  if (!Array.isArray(rewrittenContent)) throw new Error('expected rewritten user content');
  const rewrittenToolResult = rewrittenContent[1];
  if (rewrittenToolResult?.type !== 'tool_result' || !Array.isArray(rewrittenToolResult.content)) throw new Error('expected rewritten tool result');
  const rewrittenImage = rewrittenToolResult.content[1];
  if (rewrittenImage?.type !== 'image') throw new Error('expected rewritten nested image');
  if (rewrittenImage.source.type !== 'base64' || nestedImage.source.type !== 'base64') throw new Error('Expected base64 images');
  assertEquals(rewrittenImage.source.media_type, 'image/webp');
  assertEquals(rewrittenImage.source.data, 'AQID');
  assertEquals(nestedImage.source.media_type, 'image/png');
  assertEquals(nestedImage.source.data, 'AAAA');
  assert(result.payload !== payload);
  assert(result.payload.messages[0] !== payload.messages[0]);
  assert(result.payload.messages[1] === untouchedMessage);
  assert(rewrittenContent[0] === outerText);
  assert(rewrittenToolResult !== toolResult);
  assert(rewrittenToolResult.content !== toolResult.content);
  assert(rewrittenToolResult.content[0] === innerText);
  assert(rewrittenImage !== nestedImage);
  assert(rewrittenImage.source !== nestedImage.source);
});

test('selects the high-res Claude cap for Opus >= 4.7 and the standard cap otherwise', async () => {
  const source = { width: 3000, height: 3000 };
  // Opus 4.7+: ~3.59 MP area cap -> sqrt(3_588_000/9e6) -> 1894.
  assertEquals(await capTargetFor('claude-opus-4.7-high', source), { width: 1894, height: 1894 });
  // Opus 4.6 and earlier: standard ~1.18 MP cap -> sqrt(1_176_000/9e6) -> 1084.
  assertEquals(await capTargetFor('claude-opus-4.6', source), { width: 1084, height: 1084 });
});

// Drives the image stage end-to-end with a header-only PNG of the requested
// dimensions and reads back the target the per-model cap resolved to. The
// PNG carries no pixel payload — image-size reads dimensions from IHDR and
// does not validate the rest of the file.
const capTargetFor = async (upstreamModelId: string, source: ImageDimensions): Promise<ImageDimensions | null> => {
  const { processor, targets } = spyProcessor();
  initImageProcessor(processor);
  const request = requestFor({
    model: 'claude-test',
    max_tokens: 10,
    messages: [
      {
        role: 'user',
        content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: pngHeaderBase64(source) } }],
      },
    ],
  }, upstreamModelId);
  await runStage(compressImages, 'anthropicMessages', request);
  return targets[0];
};

const pngHeaderBase64 = ({ width, height }: ImageDimensions): string => {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  bytes.set([0x08, 0x02, 0x00, 0x00, 0x00], 24);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
};
