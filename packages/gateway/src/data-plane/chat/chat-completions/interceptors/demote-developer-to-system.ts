// Demote `developer` role to `system` for upstreams that don't recognise
// the `developer` role (e.g. DeepSeek). Always-attached; flag-gated by
// `demote-developer-to-system`. Runs before vendor normalizers so the
// role-mapped messages feed into any later vendor dialect rewrites.
//
// Outbound (request → upstream):
//
// - Every message with `role: 'developer'` is rewritten to `role: 'system'`.
//
// Inbound: nothing — responses don't carry message roles.

import type { ChatCompletionsInterceptor } from './types.ts';
import type { ChatCompletionsMessage } from '@floway-dev/protocols/chat-completions';

const downgradeRole = (message: ChatCompletionsMessage): ChatCompletionsMessage => {
  if (message.role !== 'developer') return message;
  return { ...message, role: 'system' as const };
};

export const withDemoteDeveloperToSystem: ChatCompletionsInterceptor = async (ctx, _gatewayCtx, run) => {
  if (!ctx.candidate.model.enabledFlags.has('demote-developer-to-system')) return await run();

  ctx.payload = {
    ...ctx.payload,
    messages: ctx.payload.messages.map(downgradeRole),
  };

  return await run();
};
