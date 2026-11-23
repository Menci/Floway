import { memoizedDataUrlCompressor } from '../image-compression.ts';
import { targetSizeForOpenAIResponsesChat } from '../image-size.ts';
import type { OpenAIChatCompletionsPayloadEx, OpenAIChatCompletionsUserContentPart, OpenAIChatCompletionsMessage } from '@floway-dev/protocols/openai-chat-completions';
import { isBase64ImageDataUrl } from '@floway-dev/provider';

type OpenAIChatCompletionsImagePart = Extract<OpenAIChatCompletionsUserContentPart, { type: 'image_url' }>;

export const compressCopilotOpenAIChatCompletionsImages = async (
  payload: OpenAIChatCompletionsPayloadEx,
  model: { readonly id: string },
): Promise<OpenAIChatCompletionsPayloadEx> => {
  const targets: OpenAIChatCompletionsImagePart[] = [];
  for (const message of payload.messages) {
    if (message.role !== 'user' || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === 'image_url' && isBase64ImageDataUrl(part.image_url.url)) targets.push(part);
    }
  }

  if (targets.length === 0) return payload;

  const compress = memoizedDataUrlCompressor(targetSizeForOpenAIResponsesChat(model.id));
  const compressedUrls = new Map<OpenAIChatCompletionsImagePart, string>();
  await Promise.all(
    targets.map(async target => {
      compressedUrls.set(target, await compress(target.image_url.url));
    }),
  );
  const hasCompressedImage = (part: OpenAIChatCompletionsUserContentPart): part is OpenAIChatCompletionsImagePart =>
    part.type === 'image_url' && compressedUrls.has(part);
  const rewriteImage = (part: OpenAIChatCompletionsImagePart): OpenAIChatCompletionsImagePart => {
    const url = compressedUrls.get(part);
    if (url === undefined) throw new Error('Missing compressed OpenAI Chat Completions image URL');
    return { ...part, image_url: { ...part.image_url, url } };
  };
  return {
    ...payload,
    messages: payload.messages.map((message): OpenAIChatCompletionsMessage => {
      if (message.role !== 'user' || !Array.isArray(message.content) || !message.content.some(hasCompressedImage)) return message;
      return {
        ...message,
        content: message.content.map(part => hasCompressedImage(part) ? rewriteImage(part) : part),
      };
    }),
  };
};
