import type { ChatCompletionsInterceptor } from './types.ts';
import type { ChatCompletionsMessage } from '@floway-dev/protocols/chat-completions';
import { providerModelOf } from '@floway-dev/provider';

export const withRoleCompatibilityApplied: ChatCompletionsInterceptor = (ctx, _gatewayCtx, run) => {
  if (ctx.targetApi !== 'chat-completions') return run();

  const flags = providerModelOf(ctx.candidate).enabledFlags;
  const rewriteSystemToDeveloper = flags.has('rewrite-system-to-developer');
  const rewriteDeveloperToSystem = flags.has('rewrite-developer-to-system');
  const rewriteMidConvSystemToUser = flags.has('rewrite-mid-conv-system-to-user');
  if (!rewriteSystemToDeveloper && !rewriteDeveloperToSystem && !rewriteMidConvSystemToUser) return run();

  let crossedLeadingSystemRun = false;
  ctx.payload = {
    ...ctx.payload,
    messages: ctx.payload.messages.map(message => {
      let mapped: ChatCompletionsMessage = message;
      if (rewriteSystemToDeveloper && mapped.role === 'system') mapped = { ...mapped, role: 'developer' };
      if (rewriteDeveloperToSystem && mapped.role === 'developer') mapped = { ...mapped, role: 'system' };
      if (!crossedLeadingSystemRun && mapped.role !== 'system') crossedLeadingSystemRun = true;
      if (rewriteMidConvSystemToUser && crossedLeadingSystemRun && mapped.role === 'system') {
        mapped = { ...mapped, role: 'user' };
      }
      return mapped;
    }),
  };

  return run();
};
