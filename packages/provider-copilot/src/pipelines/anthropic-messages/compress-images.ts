import type { CopilotService } from '../../service.ts';
import { defineCopilotStage } from '../facts.ts';
import { compressBase64ImageToWebp } from '../shared/image-compression.ts';
import { move, transform } from '@floway-dev/pipeline';
import { fitWithin, type SizeCaps } from '@floway-dev/platform';
import type { AnthropicMessagesCountTokensPayload, AnthropicMessagesPayload, AnthropicMessagesToolResultBlock, AnthropicMessagesToolResultContentBlock, AnthropicMessagesUserContentBlock } from '@floway-dev/protocols/anthropic-messages';

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

type Payload = AnthropicMessagesPayload | AnthropicMessagesCountTokensPayload;
type ContentBlock = AnthropicMessagesToolResultContentBlock | AnthropicMessagesUserContentBlock;

const compressRequests = async <Request extends Payload>(payload: Request, model: string, compress: CopilotService['compressImage']): Promise<Request> => {
  const sources = new Set<string>();
  const collect = (block: ContentBlock): void => {
    if (block.type === 'image' && block.source.type === 'base64') sources.add(block.source.data);
  };
  for (const message of payload.messages) {
    if (message.role !== 'user' || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      collect(block);
      if (block.type === 'tool_result' && Array.isArray(block.content)) block.content.forEach(collect);
    }
  }
  if (sources.size === 0) return payload;

  const caps = claudeImageCaps(model);
  const compressed = new Map(await Promise.all([...sources].map(async base64 => [base64, await compressBase64ImageToWebp(compress, base64, source => fitWithin(source, caps))] as const)));
  const hasCompressedImage = (block: ContentBlock): boolean =>
    block.type === 'image' && block.source.type === 'base64' && compressed.has(block.source.data);
  const hasCompressedToolResult = (block: AnthropicMessagesUserContentBlock): block is AnthropicMessagesToolResultBlock & { content: AnthropicMessagesToolResultContentBlock[] } =>
    block.type === 'tool_result' && Array.isArray(block.content) && block.content.some(hasCompressedImage);
  const rewrite = <Block extends ContentBlock>(block: Block): Block => {
    if (block.type !== 'image' || block.source.type !== 'base64') return block;
    const data = compressed.get(block.source.data);
    return data === undefined ? block : { ...block, source: { type: 'base64', media_type: 'image/webp', data } };
  };

  return {
    ...payload,
    messages: payload.messages.map(message => message.role !== 'user'
      || !Array.isArray(message.content)
      || !message.content.some(block => hasCompressedImage(block) || hasCompressedToolResult(block))
      ? message
      : {
          ...message,
          content: message.content.map(block =>
            hasCompressedToolResult(block)
              ? { ...block, content: block.content.map(rewrite) }
              : rewrite(block)),
        }),
  };
};

export const compressImages = defineCopilotStage({
  name: 'copilot.anthropicMessages.compressImages',
  through: {
    request: { needs: ['request.anthropicMessages', 'provider.model'], provides: ['request.anthropicMessages'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(scope => ({
    async request(facts) {
      const payload = facts['request.anthropicMessages'];
      const compressed = await compressRequests(payload, facts['provider.model'].id, scope.services.copilot.compressImage);
      return compressed === payload ? facts : { ...facts, 'request.anthropicMessages': move(compressed) };
    },
  })),
});
