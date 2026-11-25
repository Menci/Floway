import { defineCopilotStage } from '../facts.ts';
import { memoizedDataUrlCompressor } from '../shared/image-compression.ts';
import { openAIImageSize } from '../shared/image-size.ts';
import { move, transform } from '@floway-dev/pipeline';
import type { OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';
import { isBase64ImageDataUrl } from '@floway-dev/provider';

const compressRequests = async (payload: OpenAIChatCompletionsPayloadEx, model: string): Promise<OpenAIChatCompletionsPayloadEx> => {
  const sources = new Set<string>();
  for (const message of payload.messages) {
    if (message.role !== 'user' || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === 'image_url' && isBase64ImageDataUrl(part.image_url.url)) sources.add(part.image_url.url);
    }
  }
  if (sources.size === 0) return payload;

  const compress = memoizedDataUrlCompressor(openAIImageSize(model));
  const compressed = new Map(await Promise.all([...sources].map(async url => [url, await compress(url)] as const)));
  return {
    ...payload,
    messages: payload.messages.map(message => message.role !== 'user' || !Array.isArray(message.content)
      ? message
      : {
          ...message,
          content: message.content.map(part => {
            if (part.type !== 'image_url') return part;
            const url = compressed.get(part.image_url.url);
            return url === undefined ? part : { ...part, image_url: { ...part.image_url, url } };
          }),
        }),
  };
};

export const compressImages = defineCopilotStage({
  name: 'copilot.openaiChatCompletions.compressImages',
  through: {
    request: { needs: ['request.openaiChatCompletions', 'provider.model'], provides: ['request.openaiChatCompletions'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    async request(facts) {
      const payload = facts['request.openaiChatCompletions'];
      const compressed = await compressRequests(payload, facts['provider.model'].id);
      return compressed === payload ? facts : { ...facts, 'request.openaiChatCompletions': move(compressed) };
    },
  })),
});
