import type { ChatAttemptOutcome, ChatPipelineServices, OpenAIChatCompletionsAttemptInput } from '../../pipeline/index.ts';
import { defineStage } from '@floway-dev/pipeline';
import type { OpenAIChatCompletionsMessage, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import { hasEnabledFlag, type ChatTargetApi } from '@floway-dev/provider';

interface Facts extends OpenAIChatCompletionsAttemptInput {
  readonly 'route.targetApi': ChatTargetApi;
}

// Role flags apply to the final native wire only. A translated target's own
// protocol chain owns compatibility after pairwise translation.
export const applyRoleCompatibility = defineStage<
  Facts,
  Pick<Facts, 'request.payload'>,
  ChatAttemptOutcome<OpenAIChatCompletionsStreamEvent>,
  ChatAttemptOutcome<OpenAIChatCompletionsStreamEvent>,
  never,
  ChatPipelineServices
>({
  name: 'applyRoleCompatibility',
  provides: ['request.payload'],
  execute: async (facts, next) => {
    if (facts['route.targetApi'] !== 'openaiChatCompletions') {
      return await next({ 'request.payload': facts['request.payload'] });
    }

    const model = facts['route.candidate'].providerModel;
    const rewriteSystemToDeveloper = hasEnabledFlag(model, 'rewrite-system-to-developer');
    const rewriteDeveloperToSystem = hasEnabledFlag(model, 'rewrite-developer-to-system');
    const rewriteMidConvSystemToUser = hasEnabledFlag(model, 'rewrite-mid-conv-system-to-user');
    if (!rewriteSystemToDeveloper && !rewriteDeveloperToSystem && !rewriteMidConvSystemToUser) {
      return await next({ 'request.payload': facts['request.payload'] });
    }

    const payload = facts['request.payload'];
    let crossedLeadingSystemRun = false;
    const messages = payload.messages.map(message => {
      let mapped: OpenAIChatCompletionsMessage = message;
      if (rewriteSystemToDeveloper && mapped.role === 'system') mapped = { ...mapped, role: 'developer' };
      if (rewriteDeveloperToSystem && mapped.role === 'developer') mapped = { ...mapped, role: 'system' };
      if (!crossedLeadingSystemRun && mapped.role !== 'system') crossedLeadingSystemRun = true;
      if (rewriteMidConvSystemToUser && crossedLeadingSystemRun && mapped.role === 'system') {
        mapped = { ...mapped, role: 'user' };
      }
      return mapped;
    });
    return await next({ 'request.payload': { ...payload, messages } });
  },
});
