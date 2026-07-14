import type { ChatCompletionsInterceptor } from './types.ts';
import type { ChatCompletionsMessage } from '@floway-dev/protocols/chat-completions';
import { providerModelOf } from '@floway-dev/provider';

export const withRoleCompatibilityApplied: ChatCompletionsInterceptor = (ctx, _gatewayCtx, run) => {
  if (ctx.targetApi !== 'chat-completions') return run();

  const flags = providerModelOf(ctx.candidate).enabledFlags;
  const promoteSystem = flags.has('promote-system-to-developer');
  const demoteDeveloper = flags.has('demote-developer-to-system');
  const demoteInterleavedSystem = flags.has('demote-interleaved-system-to-user');
  if (!promoteSystem && !demoteDeveloper && !demoteInterleavedSystem) return run();

  let crossedLeadingSystemRun = false;
  ctx.payload = {
    ...ctx.payload,
    messages: ctx.payload.messages.map(message => {
      let mapped: ChatCompletionsMessage = message;
      if (promoteSystem && mapped.role === 'system') mapped = { ...mapped, role: 'developer' };
      if (demoteDeveloper && mapped.role === 'developer') mapped = { ...mapped, role: 'system' };
      if (!crossedLeadingSystemRun && mapped.role !== 'system') crossedLeadingSystemRun = true;
      if (demoteInterleavedSystem && crossedLeadingSystemRun && mapped.role === 'system') {
        mapped = { ...mapped, role: 'user' };
      }
      return mapped;
    }),
  };

  return run();
};
