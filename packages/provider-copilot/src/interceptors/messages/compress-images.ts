import type { MessagesBoundaryCtx, MessagesCountTokensBoundaryCtx } from './types.ts';
import { type ImageSizeCalculator, type SizeCaps, fitWithin } from '@floway-dev/platform';
import type { MessagesImageBlock, MessagesMessage } from '@floway-dev/protocols/messages';
import { memoizedBase64Compressor } from '@floway-dev/provider';

// Per-model image caps for the Claude (Messages) egress, measured from the real
// /v1/messages generation path (count_tokens misreports the downscale here).
// Copilot's Messages endpoint is Anthropic-only by Copilot's own contract, so
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

// Anthropic carries inline images both at the top level of a message's content
// and nested inside tool_result content, mirroring the vision-header scan.
const collectImageBlocks = (messages: MessagesMessage[]): MessagesImageBlock[] => {
  const blocks: MessagesImageBlock[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === 'image') blocks.push(block);
      else if (block.type === 'tool_result' && Array.isArray(block.content)) {
        for (const inner of block.content) {
          if (inner.type === 'image') blocks.push(inner);
        }
      }
    }
  }
  return blocks;
};

const compressInlineImages = async (ctx: MessagesBoundaryCtx | MessagesCountTokensBoundaryCtx): Promise<void> => {
  const blocks = collectImageBlocks(ctx.payload.messages);
  if (blocks.length === 0) return;

  const caps = claudeImageCaps(ctx.model.id);
  const targetSize: ImageSizeCalculator = source => fitWithin(source, caps);
  const compress = memoizedBase64Compressor(targetSize);
  await Promise.all(
    blocks.map(async block => {
      block.source.data = await compress(block.source.data);
      block.source.media_type = 'image/webp';
    }),
  );
};

// Recompresses every inline base64 image in the outgoing Messages payload to
// WebP before the Copilot upstream call. Generic in the run-result type so the
// same definition serves both the streaming Messages boundary chain and the
// count_tokens boundary chain, so count_tokens sizes the same recompressed
// payload the chat path sends.
export const withInlineImagesCompressed = async <TResult>(
  ctx: MessagesBoundaryCtx | MessagesCountTokensBoundaryCtx,
  _request: object,
  run: () => Promise<TResult>,
): Promise<TResult> => {
  // Finish this nested activation before starting the upstream call. Its
  // request-local memoizer keys are the full source base64 strings, which can
  // be several megabytes each and must not stay live for the response stream.
  await compressInlineImages(ctx);
  return await run();
};
