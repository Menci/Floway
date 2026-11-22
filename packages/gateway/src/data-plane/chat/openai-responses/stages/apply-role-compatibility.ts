import type { OpenAIResponsesStageFacts, OpenAIResponsesStageOutcome } from './facts.ts';
import type { ChatPipelineServices } from '../../pipeline/index.ts';
import { defineStage } from '@floway-dev/pipeline';
import type { CanonicalOpenAIResponsesInputItem } from '@floway-dev/protocols/openai-responses';
import { hasEnabledFlag } from '@floway-dev/provider';

// Role flags apply to the final native wire only, in the fixed order
// system-to-developer, developer-to-system, then mid-conversation system-to-user.
export const applyRoleCompatibility = defineStage<
  OpenAIResponsesStageFacts,
  Pick<OpenAIResponsesStageFacts, 'request.payload'>,
  OpenAIResponsesStageOutcome,
  OpenAIResponsesStageOutcome,
  never,
  ChatPipelineServices
>({
  name: 'applyRoleCompatibility',
  provides: ['request.payload'],
  execute: async (facts, next) => {
    if (facts['route.targetApi'] !== 'openaiResponses') return await next({ 'request.payload': facts['request.payload'] });
    const model = facts['route.candidate'].providerModel;
    const rewriteSystemToDeveloper = hasEnabledFlag(model, 'rewrite-system-to-developer');
    const rewriteDeveloperToSystem = hasEnabledFlag(model, 'rewrite-developer-to-system');
    const rewriteMidConvSystemToUser = hasEnabledFlag(model, 'rewrite-mid-conv-system-to-user');
    if (!rewriteSystemToDeveloper && !rewriteDeveloperToSystem && !rewriteMidConvSystemToUser) {
      return await next({ 'request.payload': facts['request.payload'] });
    }

    const payload = facts['request.payload'];
    let crossedLeadingSystemRun = false;
    const input = payload.input.map(item => {
      let mapped: CanonicalOpenAIResponsesInputItem = item;
      if (mapped.type === 'message' && rewriteSystemToDeveloper && mapped.role === 'system') {
        mapped = { ...mapped, role: 'developer' };
      }
      if (mapped.type === 'message' && rewriteDeveloperToSystem && mapped.role === 'developer') {
        mapped = { ...mapped, role: 'system' };
      }
      const isSystemMessage = mapped.type === 'message' && mapped.role === 'system';
      if (!crossedLeadingSystemRun && !isSystemMessage) crossedLeadingSystemRun = true;
      if (rewriteMidConvSystemToUser && crossedLeadingSystemRun && mapped.type === 'message' && mapped.role === 'system') {
        mapped = { ...mapped, role: 'user' };
      }
      return mapped;
    });
    return await next({ 'request.payload': { ...payload, input } });
  },
});
