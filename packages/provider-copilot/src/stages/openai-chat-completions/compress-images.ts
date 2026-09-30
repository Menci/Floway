import type { ChatCompletionsFacts } from '../../chat-facts.ts';
import { memoizedDataUrlCompressor } from '../../interceptors/image-compression.ts';
import { targetSizeForOpenAIResponsesChat } from '../../interceptors/image-size.ts';
import { defineStage, move } from '@floway-dev/pipeline';
import type { OpenAIChatCompletionsPayload, OpenAIChatCompletionsContentPart, OpenAIChatCompletionsMessage } from '@floway-dev/protocols/openai-chat-completions';
import { type ProviderModelFacts } from '@floway-dev/provider';
import { isBase64ImageDataUrl } from '@floway-dev/provider';

type OpenAIChatCompletionsImagePart = Extract<OpenAIChatCompletionsContentPart, { type: 'image_url' }>;

const compressInlineImages = async (payload: OpenAIChatCompletionsPayload, model: ProviderModelFacts): Promise<OpenAIChatCompletionsPayload> => {
  const targets: OpenAIChatCompletionsImagePart[] = [];
  for (const message of payload.messages) {
    if (!Array.isArray(message.content)) continue;
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
  const hasCompressedImage = (part: OpenAIChatCompletionsContentPart): part is OpenAIChatCompletionsImagePart =>
    part.type === 'image_url' && compressedUrls.has(part);
  const rewriteImage = (part: OpenAIChatCompletionsImagePart): OpenAIChatCompletionsImagePart => {
    const url = compressedUrls.get(part);
    if (url === undefined) throw new Error('Missing compressed OpenAI Chat Completions image URL');
    return { ...part, image_url: { ...part.image_url, url } };
  };
  return {
    ...payload,
    messages: payload.messages.map((message): OpenAIChatCompletionsMessage => {
      if (!Array.isArray(message.content) || !message.content.some(hasCompressedImage)) return message;
      return {
        ...message,
        content: message.content.map(part => hasCompressedImage(part) ? rewriteImage(part) : part),
      };
    }),
  };
};

// Recompresses every inline base64 image (`data:image/*;base64,...` in an
// `image_url` part) in the outgoing OpenAI Chat Completions payload to WebP before
// the Copilot upstream call. Remote https image references are left untouched.

export const copilotOpenAIChatCompletionsCompressImages = defineStage<ChatCompletionsFacts, ChatCompletionsFacts, object, object>({
  name: 'copilotOpenAIChatCompletionsCompressImages',
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
