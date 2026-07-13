import { targetSizeForResponsesChat } from '../image-size.ts';
import type { ResponsesBoundaryCtx } from './types.ts';
import type { ResponsesInputImage } from '@floway-dev/protocols/responses';
import { isBase64ImageDataUrl, memoizedDataUrlCompressor } from '@floway-dev/provider';

// A cyber-policy retry re-enters this boundary with the same nested image
// part. Remember the exact generated URL on that request-owned object so the
// retry neither re-encodes a lossy WebP nor mistakes an unrelated client WebP
// for our output. The non-enumerable property stays off the wire and does not
// cross an object-spread/JSON ownership boundary.
const compressedImageUrl = Symbol('compressedImageUrl');
type CompressibleImagePart = ResponsesInputImage & { [compressedImageUrl]?: string };

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
  const targets: Array<{ part: CompressibleImagePart; imageUrl: string }> = [];
  for (const item of ctx.payload.input) {
    const parts = item.type === 'message' ? item.content : item.type === 'function_call_output' ? item.output : undefined;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (
        part.type === 'input_image'
        && typeof part.image_url === 'string'
        && part[compressedImageUrl] !== part.image_url
        && isBase64ImageDataUrl(part.image_url)
      ) {
        targets.push({ part, imageUrl: part.image_url });
      }
    }
  }

  if (targets.length > 0) {
    const compress = memoizedDataUrlCompressor(targetSizeForResponsesChat(ctx.model.id));
    await Promise.all(
      targets.map(async target => {
        target.part.image_url = await compress(target.imageUrl);
        Object.defineProperty(target.part, compressedImageUrl, {
          configurable: true,
          value: target.part.image_url,
          writable: true,
        });
      }),
    );
  }

  return await run();
};
