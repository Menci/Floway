import { memoizedDataUrlCompressor } from '../image-compression.ts';
import { targetSizeForOpenAIResponsesChat } from '../image-size.ts';
import type { CanonicalOpenAIResponsesPayload, CanonicalOpenAIResponsesInputItem, OpenAIResponsesInputContent, OpenAIResponsesInputImage, OpenAIResponsesOutputRefusal, OpenAIResponsesToolOutputContent } from '@floway-dev/protocols/openai-responses';
import { isBase64ImageDataUrl } from '@floway-dev/provider';

type CompressibleImagePart = OpenAIResponsesInputImage & { image_url: string };

export const compressCopilotOpenAIResponsesImages = async (
  payload: CanonicalOpenAIResponsesPayload,
  model: { readonly id: string },
): Promise<CanonicalOpenAIResponsesPayload> => {
  const targets: Array<{ part: CompressibleImagePart; imageUrl: string }> = [];
  for (const item of payload.input) {
    const parts = item.type === 'message'
      ? item.content
      : item.type === 'function_call_output' || item.type === 'custom_tool_call_output' ? item.output : undefined;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (part.type !== 'input_image' || typeof part.image_url !== 'string') continue;
      const imagePart = part as CompressibleImagePart;
      if (!isBase64ImageDataUrl(imagePart.image_url)) continue;
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
  const hasCompressedImage = (part: OpenAIResponsesInputContent | OpenAIResponsesOutputRefusal): part is CompressibleImagePart =>
    part.type === 'input_image' && compressedUrls.has(part as CompressibleImagePart);
  const rewriteImage = (part: CompressibleImagePart): CompressibleImagePart => {
    const imageUrl = compressedUrls.get(part);
    if (imageUrl === undefined) throw new Error('Missing compressed OpenAI Responses image URL');
    return { ...part, image_url: imageUrl };
  };
  const rewriteParts = <TPart extends OpenAIResponsesInputContent | OpenAIResponsesOutputRefusal | OpenAIResponsesToolOutputContent>(parts: TPart[]): TPart[] =>
    parts.map(part => hasCompressedImage(part) ? rewriteImage(part) as TPart : part);

  return {
    ...payload,
    input: payload.input.map(item => {
      if (item.type === 'message' && Array.isArray(item.content)) {
        return item.content.some(hasCompressedImage)
          ? { ...item, content: rewriteParts(item.content) } as CanonicalOpenAIResponsesInputItem
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
