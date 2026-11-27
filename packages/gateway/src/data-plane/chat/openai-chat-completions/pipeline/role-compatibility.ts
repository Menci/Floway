import { defineStage } from '../../pipeline/facts.ts';
import type { OpenAIChatCompletionsMessage } from '@floway-dev/protocols/openai-chat-completions';

export const rewriteOpenAIChatCompletionsRoles = defineStage({
  name: 'openaiChatCompletions.apply-role-compatibility',
  through: {
    request: { needs: ['openaiChatCompletions', 'model'], provides: ['openaiChatCompletions'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    const { enabledFlags } = facts.model;
    const systemToDeveloper = enabledFlags.includes('rewrite-system-to-developer');
    const developerToSystem = enabledFlags.includes('rewrite-developer-to-system');
    const midConversationSystemToUser = enabledFlags.includes('rewrite-mid-conv-system-to-user');
    if (!systemToDeveloper && !developerToSystem && !midConversationSystemToUser) return await scope.next(facts);

    let crossedLeadingSystemRun = false;
    const payload = facts.openaiChatCompletions;
    const messages = payload.messages.map(message => {
      let mapped: OpenAIChatCompletionsMessage = message;
      if (systemToDeveloper && mapped.role === 'system') mapped = { ...mapped, role: 'developer' };
      if (developerToSystem && mapped.role === 'developer') mapped = { ...mapped, role: 'system' };
      if (mapped.role !== 'system') crossedLeadingSystemRun = true;
      if (midConversationSystemToUser && crossedLeadingSystemRun && mapped.role === 'system') mapped = { ...mapped, role: 'user' };
      return mapped;
    });
    return await scope.next({ ...facts, openaiChatCompletions: { ...payload, messages } });
  },
});
