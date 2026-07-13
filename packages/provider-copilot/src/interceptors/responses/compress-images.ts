import { targetSizeForResponsesChat } from '../image-size.ts';
import type { ResponsesBoundaryCtx } from './types.ts';
import type { ResponsesInputImage } from '@floway-dev/protocols/responses';
import { isBase64ImageDataUrl, memoizedDataUrlCompressor } from '@floway-dev/provider';

const compressInlineImages = async (ctx: ResponsesBoundaryCtx): Promise<void> => {
  const targets: Array<{ part: ResponsesInputImage; imageUrl: string }> = [];
  for (const item of ctx.payload.input) {
    const parts = item.type === 'message' ? item.content : item.type === 'function_call_output' ? item.output : undefined;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (part.type === 'input_image' && typeof part.image_url === 'string' && isBase64ImageDataUrl(part.image_url)) {
        targets.push({ part, imageUrl: part.image_url });
      }
    }
  }

  if (targets.length === 0) return;

  const compress = memoizedDataUrlCompressor(targetSizeForResponsesChat(ctx.model.id));
  await Promise.all(
    targets.map(async target => {
      target.part.image_url = await compress(target.imageUrl);
    }),
  );
};

// Recompresses every inline base64 image in the outgoing Responses payload to
// WebP before the Copilot upstream call. Images appear both as `input_image`
// parts inside message content and inside `function_call_output` outputs
// (multimodal tool results, e.g. a screenshot tool). Remote https image
// references are left untouched. Generic in the run-result type so the same
// definition feeds both the streaming `/responses` chain and the
// non-streaming compaction chain.
export const withInlineImagesCompressed = async <TResult>(
  ctx: ResponsesBoundaryCtx,
  _request: object,
  run: () => Promise<TResult>,
): Promise<TResult> => {
  // Finish this nested activation before starting the upstream call. Its
  // request-local memoizer keys are the full source data URLs, which can be
  // several megabytes each and must not stay live for the response stream.
  await compressInlineImages(ctx);
  return await run();
};
