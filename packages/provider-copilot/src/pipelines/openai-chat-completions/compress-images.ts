import { compressDataUrlImages } from '../shared/image-compression.ts';
import { targetSizeForOpenAIResponsesChat } from '../shared/image-size.ts';
import { mapChanged } from '../shared/map-changed.ts';
import { rewritePayload } from '../shared/rewrite-payload.ts';
import type { OpenAIChatCompletionsMessage } from '@floway-dev/protocols/openai-chat-completions';

const imageUrls = function* (messages: OpenAIChatCompletionsMessage[]): Generator<string> {
  for (const message of messages) {
    if (message.role !== 'user' || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === 'image_url') yield part.image_url.url;
    }
  }
};

export const compressImages = rewritePayload('openaiChatCompletions', 'compressImages', async (payload, _model, { copilot }) => {
  const compressed = await compressDataUrlImages(imageUrls(payload.messages), targetSizeForOpenAIResponsesChat(payload.model), copilot.compressImage);
  if (compressed.size === 0) return payload;
  const messages = mapChanged(payload.messages, message => {
    if (message.role !== 'user' || !Array.isArray(message.content)) return message;
    const content = mapChanged(message.content, part => {
      if (part.type !== 'image_url') return part;
      const url = compressed.get(part.image_url.url);
      return url === undefined ? part : { ...part, image_url: { ...part.image_url, url } };
    });
    return content === message.content ? message : { ...message, content };
  });
  return { ...payload, messages };
});
