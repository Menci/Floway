import type { ResponsesInterceptor } from './types.ts';
import { providerModelOf } from '@floway-dev/provider';

// Workaround for upstreams (e.g. DeepSeek-R1) that reject `role: 'system'`
// after the first non-system message. The Responses input is a mixed
// sequence of message items (with a `role`) and non-message items
// (reasoning, function_call, function_call_output, …). The leading
// contiguous run of `role: 'system'` message items is the only valid
// system position; once we cross into anything else — a user/assistant/
// developer message or any non-message item — every later
// `role: 'system'` message item is rewritten to `role: 'user'` with its
// content kept verbatim.
export const withInterleavedSystemDemotedToUser: ResponsesInterceptor = (ctx, _gatewayCtx, run) => {
  if (!providerModelOf(ctx.candidate).enabledFlags.has('demote-interleaved-system-to-user')) return run();

  const { input } = ctx.payload;
  let crossedLeadingRun = false;
  for (let i = 0; i < input.length; i++) {
    const item = input[i];
    const isSystemMessage = item.type === 'message' && item.role === 'system';
    if (!crossedLeadingRun && !isSystemMessage) {
      crossedLeadingRun = true;
      continue;
    }
    if (crossedLeadingRun && isSystemMessage) {
      input[i] = { ...item, role: 'user' };
    }
  }

  return run();
};
