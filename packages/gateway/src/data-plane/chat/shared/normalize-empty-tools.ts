import type { ChatFacts, Chat } from '../facts.ts';
import { defineStage, move } from '@floway-dev/pipeline';

type EmptyToolsProtocol = 'request.chat.openaiChatCompletions' | 'request.chat.openaiResponses' | 'request.chat.anthropicMessages';

export const normalizeEmptyTools = <Key extends EmptyToolsProtocol>(key: Key, rewrite: (payload: ChatFacts[Key]) => ChatFacts[Key]) => defineStage<
  Chat<Key | 'route.attempt'>, Chat<Key>, Record<string, never>, Record<string, never>
>({
  name: 'normalizeEmptyToolsToolChoice',
  through: {
    request: { needs: [key, 'route.attempt'], consumes: [], provides: [key] },
    response: { needs: [], consumes: [], provides: [] },
  },
  execute: async (facts, next) => {
    if (!facts['route.attempt'].flags.includes('empty-tools-tool-choice-none')) return await next(facts);
    const payload = facts[key];
    if (!Array.isArray(payload.tools) || payload.tools.length !== 0) return await next(facts);
    const rewritten = rewrite(payload);
    return await next(rewritten === payload ? facts : { ...facts, [key]: move(rewritten) } as never);
  },
});
