import type { ResponsesFacts } from '../../chat-facts.ts';
import { memoizedDataUrlCompressor } from '../../image-compression.ts';
import { targetSizeForOpenAIResponsesChat } from '../../image-size.ts';
import { defineStage, move } from '@floway-dev/pipeline';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesInputContent, OpenAIResponsesInputImage, OpenAIResponsesToolOutputContent } from '@floway-dev/protocols/openai-responses';
import { type ProviderModelFacts } from '@floway-dev/provider';
import { isBase64ImageDataUrl } from '@floway-dev/provider';

// Identity provenance prevents a repeated attempt from recompressing our own WebP output.
// A weak side table leaves handed-over image facts immutable and releases their data with them.
const compressedImageUrls = new WeakMap<object, string>();
type CompressibleImagePart = OpenAIResponsesInputImage & { image_url: string };

const compressInlineImages = async (payload: CanonicalOpenAIResponsesPayload, model: ProviderModelFacts): Promise<CanonicalOpenAIResponsesPayload> => {
  const targets: Array<{ part: CompressibleImagePart; imageUrl: string }> = [];
  for (const item of payload.input) {
    const parts = item.type === 'message'
      ? item.content
      : item.type === 'function_call_output' || item.type === 'custom_tool_call_output' ? item.output : undefined;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (part.type !== 'input_image' || typeof part.image_url !== 'string') continue;
      const imagePart = part as CompressibleImagePart;
      if (compressedImageUrls.get(imagePart) === imagePart.image_url || !isBase64ImageDataUrl(imagePart.image_url)) continue;
      targets.push({ part: imagePart, imageUrl: imagePart.image_url });
    }
  }

  if (targets.length === 0) return payload;

  const compress = memoizedDataUrlCompressor(targetSizeForOpenAIResponsesChat(model.id));
  const compressedUrls = new Map<CompressibleImagePart, string>();
  await Promise.all(
    targets.map(async target => {
      compressedUrls.set(target.part, await compress(target.imageUrl));
    }),
  );
  const hasCompressedImage = (part: OpenAIResponsesInputContent): part is CompressibleImagePart =>
    part.type === 'input_image' && compressedUrls.has(part as CompressibleImagePart);
  const rewriteImage = (part: CompressibleImagePart): CompressibleImagePart => {
    const imageUrl = compressedUrls.get(part);
    if (imageUrl === undefined) throw new Error('Missing compressed OpenAI Responses image URL');
    const rewritten: CompressibleImagePart = { ...part, image_url: imageUrl };
    compressedImageUrls.set(rewritten, imageUrl);
    return rewritten;
  };
  const rewriteParts = <TPart extends OpenAIResponsesInputContent | OpenAIResponsesToolOutputContent>(parts: TPart[]): TPart[] =>
    parts.map(part => hasCompressedImage(part) ? rewriteImage(part) as TPart : part);

  return {
    ...payload,
    input: payload.input.map(item => {
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

// Recompresses every inline base64 image in the outgoing OpenAI Responses payload to
// WebP before the Copilot upstream call. Images appear both as `input_image`
// parts inside message content and inside function/custom tool outputs
// (multimodal tool results, e.g. a screenshot tool). Remote https and file-id
// references are left untouched. Generic in the run-result type so the same
// definition feeds both the streaming `/responses` chain and the non-streaming
// compaction chain.

export const copilotOpenAIResponsesCompressImages = defineStage<ResponsesFacts, ResponsesFacts, object, object>({
  name: 'copilotOpenAIResponsesCompressImages',
  through: {
    request: { needs: ['request.provider.payload', 'request.provider.model'], consumes: ['request.provider.payload'], provides: ['request.provider.payload'] },
    response: { needs: [], consumes: [], provides: [] },
  },
  execute: async (facts, next) => {
    let payload = facts['request.provider.payload'];
    const model = facts['request.provider.model'];

    payload = await compressInlineImages(payload, model);

    return move({ ...await next(move({ ...facts, 'request.provider.payload': payload })) });
  },
});
