import { targetSizeForResponsesChat } from '../image-size.ts';
import type { ResponsesBoundaryCtx } from './types.ts';
import type { ResponsesInputContent, ResponsesInputImage } from '@floway-dev/protocols/responses';
import { isBase64ImageDataUrl, memoizedDataUrlCompressor } from '@floway-dev/provider';

// Recompresses every inline base64 image in the outgoing Responses payload to
// WebP before the Copilot upstream call. Images appear both as `input_image`
// parts inside message content and inside function/custom tool outputs
// (multimodal tool results, e.g. a screenshot tool). Remote https and file-id
// references are left untouched. Generic in the run-result type so the same
// definition feeds both the streaming `/responses` chain and the non-streaming
// compaction chain.
export const withInlineImagesCompressed = async <TResult>(
  ctx: ResponsesBoundaryCtx,
  _request: object,
  run: () => Promise<TResult>,
): Promise<TResult> => {
  const targets: Array<{ part: ResponsesInputImage; imageUrl: string }> = [];
  for (const item of ctx.payload.input) {
    const parts = item.type === 'message'
      ? item.content
      : item.type === 'function_call_output' || item.type === 'custom_tool_call_output' ? item.output : undefined;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (part.type === 'input_image' && typeof part.image_url === 'string' && isBase64ImageDataUrl(part.image_url)) {
        targets.push({ part, imageUrl: part.image_url });
      }
    }
  }

  if (targets.length > 0) {
    const compress = memoizedDataUrlCompressor(targetSizeForResponsesChat(ctx.model.id));
    const compressedUrls = new Map<ResponsesInputImage, string>();
    await Promise.all(
      targets.map(async target => {
        compressedUrls.set(target.part, await compress(target.imageUrl));
      }),
    );
    const hasCompressedImage = (part: ResponsesInputContent): part is ResponsesInputImage =>
      part.type === 'input_image' && compressedUrls.has(part);
    const rewriteImage = (part: ResponsesInputImage): ResponsesInputImage => {
      const imageUrl = compressedUrls.get(part);
      if (imageUrl === undefined) throw new Error('Missing compressed Responses image URL');
      return { ...part, image_url: imageUrl };
    };
    const rewriteParts = (parts: ResponsesInputContent[]): ResponsesInputContent[] =>
      parts.map(part => hasCompressedImage(part) ? rewriteImage(part) : part);

    ctx.payload = {
      ...ctx.payload,
      input: ctx.payload.input.map(item => {
        if (item.type === 'message' && Array.isArray(item.content)) {
          return item.content.some(hasCompressedImage)
            ? { ...item, content: rewriteParts(item.content) }
            : item;
        }
        if ((item.type === 'function_call_output' || item.type === 'custom_tool_call_output') && Array.isArray(item.output)) {
          return item.output.some(hasCompressedImage)
            ? { ...item, output: rewriteParts(item.output) }
            : item;
        }
        return item;
      }),
    };
  }

  return await run();
};
