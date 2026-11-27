import type { CopilotServices } from '../../service.ts';
import { defineCopilotStage } from '../facts.ts';
import { compressDataUrlImages } from '../shared/image-compression.ts';
import { targetSizeForOpenAIResponsesChat } from '../shared/image-size.ts';
import { mapChanged } from '../shared/map-changed.ts';
import type { OpenAIChatCompletionsMessage, OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';

const imageUrls = function* (messages: OpenAIChatCompletionsMessage[]): Generator<string> {
  for (const message of messages) {
    if (message.role !== 'user' || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === 'image_url') yield part.image_url.url;
    }
  }
};

const compressInlineImages = async (payload: OpenAIChatCompletionsPayloadEx, modelId: string, { copilot }: Readonly<CopilotServices>): Promise<OpenAIChatCompletionsPayloadEx> => {
  const compressed = await compressDataUrlImages(imageUrls(payload.messages), targetSizeForOpenAIResponsesChat(modelId), copilot.compressImage);
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
};

export const compressImages = defineCopilotStage({
  name: 'copilot.openaiChatCompletions.compressImages',
  through: {
    request: { needs: ['openaiChatCompletions', 'model'], provides: ['openaiChatCompletions'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const payload = facts.openaiChatCompletions;
    const updated = await compressInlineImages(payload, facts.model.id, scope.services);
    return await scope.next(updated === payload ? facts : { ...facts, openaiChatCompletions: updated });
  },
});
