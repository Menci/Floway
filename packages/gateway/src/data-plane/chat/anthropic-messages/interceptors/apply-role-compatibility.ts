import type { AnthropicMessagesPayloadInterceptor } from './types.ts';
import type { AnthropicMessagesTextBlock } from '@floway-dev/protocols/anthropic-messages';
import { providerModelOf } from '@floway-dev/provider';

export const withRoleCompatibilityApplied: AnthropicMessagesPayloadInterceptor = (ctx, _gatewayCtx, run) => {
  if (ctx.targetApi !== 'anthropicMessages') return run();
  if (!providerModelOf(ctx.candidate).enabledFlags.has('rewrite-mid-conv-system-to-user')) return run();

  ctx.payload = {
    ...ctx.payload,
    messages: ctx.payload.messages.map(message => {
      if (message.role !== 'system') return message;
      if (typeof message.content === 'string') return { role: 'user' as const, content: message.content };
      const invalid = message.content.find(block => block.type !== 'text');
      if (invalid !== undefined) throw new Error(`Cannot rewrite Anthropic ${invalid.type} as user content.`);
      return { role: 'user' as const, content: message.content as AnthropicMessagesTextBlock[] };
    }),
  };

  return run();
};
