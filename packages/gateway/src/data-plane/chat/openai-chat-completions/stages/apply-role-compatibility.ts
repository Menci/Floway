import { rewriteChatRequest } from '../../shared/rewrite-stage.ts';
import type { OpenAIChatCompletionsMessage, OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';

export const applyRoleCompatibility = rewriteChatRequest(
  'applyRoleCompatibility', 'request.payload', (payload: OpenAIChatCompletionsPayloadEx, { providerModel }) => {
    const flags = providerModel.enabledFlags;
    const systemToDeveloper = flags.includes('rewrite-system-to-developer');
    const developerToSystem = flags.includes('rewrite-developer-to-system');
    const midConversationSystemToUser = flags.includes('rewrite-mid-conv-system-to-user');
    if (!systemToDeveloper && !developerToSystem && !midConversationSystemToUser) return payload;

    let crossedLeadingSystemRun = false;
    return {
      ...payload,
      messages: payload.messages.map(message => {
        let mapped: OpenAIChatCompletionsMessage = message;
        if (systemToDeveloper && mapped.role === 'system') mapped = { ...mapped, role: 'developer' };
        if (developerToSystem && mapped.role === 'developer') mapped = { ...mapped, role: 'system' };
        if (mapped.role !== 'system') crossedLeadingSystemRun = true;
        if (midConversationSystemToUser && crossedLeadingSystemRun && mapped.role === 'system') mapped = { ...mapped, role: 'user' };
        return mapped;
      }),
    };
  },
);
