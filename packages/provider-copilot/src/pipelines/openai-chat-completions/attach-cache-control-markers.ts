import { defineCopilotStage } from '../facts.ts';
import { move, transform } from '@floway-dev/pipeline';
import type { OpenAIChatCompletionsMessage } from '@floway-dev/protocols/openai-chat-completions';
// https://github.com/caozhiyuan/copilot-api/blob/9be0eb602f1ffee7597741c9af9bc66a68e1a241/src/routes/messages/api-flows.ts#L381-L432
export type CopilotCacheableMessage = OpenAIChatCompletionsMessage & { copilot_cache_control?: { type: 'ephemeral' } };

const COPILOT_CONTEXT_CACHE_SYSTEM_MARKER_LIMIT = 2;
const COPILOT_CONTEXT_CACHE_NON_SYSTEM_MARKER_LIMIT = 2;
const COPILOT_CONTEXT_CACHE_CONTROL = { type: 'ephemeral' } as const;

const isEligible = (message: OpenAIChatCompletionsMessage): boolean => {
  const { content } = message;
  if (typeof content === 'string') return content.length > 0;
  return Array.isArray(content) && content.length > 0;
};

const selectCacheMarkerIndexes = (messages: readonly OpenAIChatCompletionsMessage[]): number[] => {
  const systemIndexes: number[] = [];
  for (let i = 0; i < messages.length && systemIndexes.length < COPILOT_CONTEXT_CACHE_SYSTEM_MARKER_LIMIT; i++) {
    if (messages[i].role === 'system' && isEligible(messages[i])) systemIndexes.push(i);
  }

  const nonSystemIndexes: number[] = [];
  for (let i = messages.length - 1; i >= 0 && nonSystemIndexes.length < COPILOT_CONTEXT_CACHE_NON_SYSTEM_MARKER_LIMIT; i--) {
    if (messages[i].role !== 'system' && isEligible(messages[i])) nonSystemIndexes.push(i);
  }

  return [...new Set([...systemIndexes, ...nonSystemIndexes])].sort((a, b) => a - b);
};
// Prime the prompt cache at the first two eligible system messages and last two eligible conversation messages.
export const attachCacheControlMarkers = defineCopilotStage({
  name: 'copilot.openaiChatCompletions.attachCacheControlMarkers',
  through: {
    request: { needs: ['request.openaiChatCompletions'], provides: ['request.openaiChatCompletions'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    request(facts) {
      const payload = facts['request.openaiChatCompletions'];
      const indexes = new Set(selectCacheMarkerIndexes(payload.messages));
      if (indexes.size === 0) return facts;
      const messages = payload.messages.map((message, index) => indexes.has(index)
        ? { ...message, copilot_cache_control: COPILOT_CONTEXT_CACHE_CONTROL }
        : message);
      const next = { ...payload, messages };
      return { ...facts, 'request.openaiChatCompletions': move(next) };
    },
  })),
});
