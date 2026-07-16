import { targetSizeForResponsesChat } from '../image-size.ts';
import type { ResponsesBoundaryCtx } from './types.ts';
import type { ResponsesInputContent, ResponsesInputImage } from '@floway-dev/protocols/responses';
import { isBase64ImageDataUrl, memoizedDataUrlCompressor } from '@floway-dev/provider';

// A cyber-policy retry re-enters this boundary with the same nested image
// part. Remember the exact generated URL on that request-owned object so the
// retry neither re-encodes a lossy WebP nor mistakes an unrelated client WebP
// for our output. The non-enumerable property stays off the wire and does not
// cross an object-spread/JSON ownership boundary.
const compressedImageUrl = Symbol('compressedImageUrl');
type CompressibleImagePart = ResponsesInputImage & { image_url: string; [compressedImageUrl]?: string };

const compressInlineImages = async (ctx: ResponsesBoundaryCtx): Promise<void> => {
  const targets: Array<{ part: CompressibleImagePart; imageUrl: string }> = [];
  for (const item of ctx.payload.input) {
    const parts = item.type === 'message'
      ? item.content
      : item.type === 'function_call_output' || item.type === 'custom_tool_call_output' ? item.output : undefined;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (part.type !== 'input_image' || typeof part.image_url !== 'string') continue;
      const imagePart = part as CompressibleImagePart;
      if (imagePart[compressedImageUrl] === imagePart.image_url || !isBase64ImageDataUrl(imagePart.image_url)) continue;
      targets.push({ part: imagePart, imageUrl: imagePart.image_url });
    }
  }

  if (targets.length === 0) return;

  const compress = memoizedDataUrlCompressor(targetSizeForResponsesChat(ctx.model.id));
  const compressedUrls = new Map<CompressibleImagePart, string>();
  await Promise.all(
    targets.map(async target => {
      compressedUrls.set(target.part, await compress(target.imageUrl));
    }),
  );
  const hasCompressedImage = (part: ResponsesInputContent): part is CompressibleImagePart =>
    part.type === 'input_image' && compressedUrls.has(part as CompressibleImagePart);
  const rewriteImage = (part: CompressibleImagePart): CompressibleImagePart => {
    const imageUrl = compressedUrls.get(part);
    if (imageUrl === undefined) throw new Error('Missing compressed Responses image URL');
    const rewritten: CompressibleImagePart = { ...part, image_url: imageUrl };
    Object.defineProperty(rewritten, compressedImageUrl, {
      configurable: true,
      value: imageUrl,
      writable: true,
    });
    return rewritten;
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
};

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
  // Finish this nested activation before starting the upstream call. Its
  // request-local memoizer keys are the full source data URLs, which can be
  // several megabytes each and must not stay live for the response stream.
  await compressInlineImages(ctx);
  return await run();
};
