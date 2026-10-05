import { dimensionsFromBytes, fitWithin, getImageProcessor } from '@floway-dev/platform';
import type {
  AnthropicMessagesImageBlock,
  AnthropicMessagesPayload,
  AnthropicMessagesToolResultBlock,
  AnthropicMessagesToolResultContentBlock,
  AnthropicMessagesUserContentBlock,
} from '@floway-dev/protocols/anthropic-messages';
import { decodeForgivingBase64, encodeBase64 } from '@floway-dev/protocols/common';

const ANTHROPIC_IMAGE_LIMIT = 8_000;
const ANTHROPIC_MANY_IMAGE_THRESHOLD = 20;
const ANTHROPIC_MANY_IMAGE_LIMIT = 2_000;

const decodedImage = (image: AnthropicMessagesImageBlock): Uint8Array | null => {
  try {
    return decodeForgivingBase64(image.source.data);
  } catch {
    // Preserve the existing boundary: malformed image payloads remain the
    // upstream's validation responsibility rather than becoming gateway 500s.
    return null;
  }
};

// Anthropic counts images nested in tool_result content as part of the whole
// request. Once a request contains more than 20 images, every image is limited
// to 2000px per dimension instead of the ordinary 8000px limit.
// https://platform.claude.com/docs/en/build-with-claude/vision#request-limits
const collectImageBlocks = (payload: AnthropicMessagesPayload): AnthropicMessagesImageBlock[] => {
  const images: AnthropicMessagesImageBlock[] = [];
  for (const message of payload.messages) {
    if (message.role !== 'user' || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === 'image') {
        images.push(block);
      } else if (block.type === 'tool_result' && Array.isArray(block.content)) {
        for (const inner of block.content) {
          if (inner.type === 'image') images.push(inner);
        }
      }
    }
  }
  return images;
};

const rewriteToolResult = (
  block: AnthropicMessagesToolResultBlock,
  replacements: ReadonlyMap<AnthropicMessagesImageBlock, AnthropicMessagesImageBlock>,
): AnthropicMessagesToolResultBlock => {
  if (!Array.isArray(block.content)) return block;
  let changed = false;
  const content = block.content.map((inner): AnthropicMessagesToolResultContentBlock => {
    if (inner.type !== 'image') return inner;
    const replacement = replacements.get(inner);
    if (replacement === undefined) return inner;
    changed = true;
    return replacement;
  });
  return changed ? { ...block, content } : block;
};

const rewriteUserContent = (
  content: AnthropicMessagesUserContentBlock[],
  replacements: ReadonlyMap<AnthropicMessagesImageBlock, AnthropicMessagesImageBlock>,
): AnthropicMessagesUserContentBlock[] => {
  let changed = false;
  const rewritten = content.map((block): AnthropicMessagesUserContentBlock => {
    if (block.type === 'image') {
      const replacement = replacements.get(block);
      if (replacement === undefined) return block;
      changed = true;
      return replacement;
    }
    if (block.type !== 'tool_result') return block;
    const replacement = rewriteToolResult(block, replacements);
    if (replacement !== block) changed = true;
    return replacement;
  });
  return changed ? rewritten : content;
};

export const applyTranslatedAnthropicImageLimits = async (payload: AnthropicMessagesPayload): Promise<void> => {
  const images = collectImageBlocks(payload);
  if (images.length === 0) return;

  const maxLongEdge = images.length > ANTHROPIC_MANY_IMAGE_THRESHOLD
    ? ANTHROPIC_MANY_IMAGE_LIMIT
    : ANTHROPIC_IMAGE_LIMIT;
  const oversized = images.flatMap(image => {
    const bytes = decodedImage(image);
    if (bytes === null) return [];
    const dimensions = dimensionsFromBytes(bytes);
    if (dimensions === null || Math.max(dimensions.width, dimensions.height) <= maxLongEdge) return [];
    return [{ image, bytes, target: fitWithin(dimensions, { maxLongEdge }) }];
  });
  if (oversized.length === 0) return;

  const processor = getImageProcessor();
  const compressedBySource = new Map<string, Promise<string>>();
  const replacements = new Map<AnthropicMessagesImageBlock, AnthropicMessagesImageBlock>();
  await Promise.all(oversized.map(async ({ image, bytes, target }) => {
    let compressed = compressedBySource.get(image.source.data);
    if (compressed === undefined) {
      compressed = processor.compressToWebp(bytes, target).then(encodeBase64);
      compressedBySource.set(image.source.data, compressed);
    }
    replacements.set(image, {
      ...image,
      source: { type: 'base64', media_type: 'image/webp', data: await compressed },
    });
  }));

  payload.messages = payload.messages.map(message => {
    if (message.role !== 'user' || !Array.isArray(message.content)) return message;
    const content = rewriteUserContent(message.content, replacements);
    return content === message.content ? message : { ...message, content };
  });
};
