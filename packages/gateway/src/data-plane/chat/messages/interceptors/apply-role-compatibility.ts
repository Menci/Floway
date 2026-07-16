import type { MessagesPayloadInterceptor } from './types.ts';
import { providerModelOf } from '@floway-dev/provider';

export const withRoleCompatibilityApplied: MessagesPayloadInterceptor = (ctx, _gatewayCtx, run) => {
  if (ctx.targetApi !== 'messages') return run();
  if (!providerModelOf(ctx.candidate).enabledFlags.has('demote-interleaved-system-to-user')) return run();

  ctx.payload = {
    ...ctx.payload,
    messages: ctx.payload.messages.map(message =>
      message.role === 'system' ? { role: 'user' as const, content: message.content } : message),
  };

  return run();
};
