import type { AnthropicMessagesOperation } from './operations.ts';
import type { CopilotServices } from '../../service.ts';
import { compressBase64Images } from '../shared/image-compression.ts';
import { mapChanged } from '../shared/map-changed.ts';
import { rewritePayload } from '../shared/rewrite-payload.ts';
import { type SizeCaps, fitWithin } from '@floway-dev/platform';
import type { AnthropicMessagesImageBlock, AnthropicMessagesMessage } from '@floway-dev/protocols/anthropic-messages';

// Per-model image caps for the Claude (Anthropic Messages) egress, measured from the real
// /v1/messages generation path (count_tokens misreports the downscale here).
// Copilot's Anthropic Messages endpoint is Anthropic-only by Copilot's own contract, so
// the caps below are Anthropic's canonical vision limits:
//
// - Opus 4.7 was the first high-resolution Claude model; Opus 4.7 and 4.8
//   sample up to ~3.59 MP within a 2576px long edge.
// - Opus 4.5 / 4.6 and the sonnet / haiku families use the standard ~1.18 MP /
//   1568px cap.
//
// We threshold on the Opus version so future Opus releases inherit the high-res
// tier; every non-Opus Claude model uses the standard cap.
//
// References:
// - Anthropic vision docs: https://docs.claude.com/en/docs/build-with-claude/vision
// - High-res Opus 4.7+ sampling: https://docs.claude.com/en/docs/build-with-claude/vision#evaluate-image-size
const STANDARD_CLAUDE_CAPS: SizeCaps = { maxLongEdge: 1568, maxArea: 1_176_000 };

const claudeImageCaps = (upstreamModelId: string): SizeCaps => {
  const opus = /opus-(\d+)(?:\.(\d+))?/.exec(upstreamModelId);
  if (!opus) return STANDARD_CLAUDE_CAPS;
  const major = Number(opus[1]);
  const minor = opus[2] === undefined ? 0 : Number(opus[2]);
  const highRes = major > 4 || (major === 4 && minor >= 7);
  return highRes ? { maxLongEdge: 2576, maxArea: 3_588_000 } : STANDARD_CLAUDE_CAPS;
};

const inlineImageData = function* (messages: AnthropicMessagesMessage[]): Generator<string> {
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === 'image' && block.source.type === 'base64') yield block.source.data;
      if (block.type !== 'tool_result' || !Array.isArray(block.content)) continue;
      for (const inner of block.content) {
        if (inner.type === 'image' && inner.source.type === 'base64') yield inner.source.data;
      }
    }
  }
};

const compressInlineImages = async <Payload extends { model: string; messages: AnthropicMessagesMessage[] }>(
  payload: Payload,
  _model: unknown,
  { copilot }: Readonly<CopilotServices>,
): Promise<Payload> => {
  const caps = claudeImageCaps(payload.model);
  const compressed = await compressBase64Images(inlineImageData(payload.messages), source => fitWithin(source, caps), copilot.compressImage);
  if (compressed.size === 0) return payload;

  const rewrite = (image: AnthropicMessagesImageBlock): AnthropicMessagesImageBlock => {
    if (image.source.type !== 'base64') return image;
    const data = compressed.get(image.source.data);
    if (data === undefined) throw new Error('Missing compressed Copilot Anthropic Messages image');
    return { ...image, source: { type: 'base64', media_type: 'image/webp', data } };
  };

  const messages = mapChanged(payload.messages, message => {
    if (!Array.isArray(message.content)) return message;
    const content = mapChanged(message.content, block => {
      if (block.type === 'image') return rewrite(block);
      if (block.type !== 'tool_result' || !Array.isArray(block.content)) return block;
      const parts = mapChanged(block.content, part => part.type === 'image' ? rewrite(part) : part);
      return parts === block.content ? block : { ...block, content: parts };
    });
    return content === message.content ? message : { ...message, content } as typeof message;
  });
  return { ...payload, messages };
};

export const compressImages = (operation: AnthropicMessagesOperation) => rewritePayload(operation, 'compressImages', compressInlineImages);
