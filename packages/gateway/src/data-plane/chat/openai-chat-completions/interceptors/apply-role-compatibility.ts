import { openAIChatCompletionsPayloadStage } from './payload-stage.ts';
import type { OpenAIChatCompletionsMessage } from '@floway-dev/protocols/openai-chat-completions';

export const applyRoleCompatibility = openAIChatCompletionsPayloadStage('apply-role-compatibility', (payload, flags) => {
  const rewriteSystemToDeveloper = flags.includes('rewrite-system-to-developer');
  const rewriteDeveloperToSystem = flags.includes('rewrite-developer-to-system');
  const rewriteMidConvSystemToUser = flags.includes('rewrite-mid-conv-system-to-user');
  if (!rewriteSystemToDeveloper && !rewriteDeveloperToSystem && !rewriteMidConvSystemToUser) return payload;

  let crossedLeadingSystemRun = false;
  return {
    ...payload,
    messages: payload.messages.map(message => {
      let mapped: OpenAIChatCompletionsMessage = message;
      if (rewriteSystemToDeveloper && mapped.role === 'system') mapped = { ...mapped, role: 'developer' };
      if (rewriteDeveloperToSystem && mapped.role === 'developer') mapped = { ...mapped, role: 'system' };
      if (!crossedLeadingSystemRun && mapped.role !== 'system') crossedLeadingSystemRun = true;
      if (rewriteMidConvSystemToUser && crossedLeadingSystemRun && mapped.role === 'system') {
        mapped = { ...mapped, role: 'user' };
      }
      return mapped;
    }),
  };

});
