import type { OpenAIResponsesInterceptor } from './types.ts';
import { isOpenAIResponsesLiteBaseInstructionsMessage, type OpenAIResponsesInputItem } from '@floway-dev/protocols/openai-responses';
import { providerModelOf } from '@floway-dev/provider';

export const withRoleCompatibilityApplied: OpenAIResponsesInterceptor = (ctx, _gatewayCtx, run) => {
  if (ctx.targetApi !== 'openaiResponses') return run();

  const flags = providerModelOf(ctx.candidate).enabledFlags;
  const rewriteSystemToDeveloper = flags.has('rewrite-system-to-developer');
  const rewriteDeveloperToSystem = flags.has('rewrite-developer-to-system');
  const rewriteMidConvSystemToUser = flags.has('rewrite-mid-conv-system-to-user');
  if (!rewriteSystemToDeveloper && !rewriteDeveloperToSystem && !rewriteMidConvSystemToUser) return run();

  let crossedLeadingSystemRun = false;
  ctx.payload = {
    ...ctx.payload,
    input: ctx.payload.input.map(item => {
      // Configuration does not begin conversation history. Lite's tagged
      // base instructions have the same role as top-level instructions,
      // which are outside this message-role compatibility transform.
      if (item.type === 'additional_tools' || item.type === 'configuration_update'
        || isOpenAIResponsesLiteBaseInstructionsMessage(item)) return item;
      let mapped: OpenAIResponsesInputItem = item;
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
    }),
  };

  return run();
};
