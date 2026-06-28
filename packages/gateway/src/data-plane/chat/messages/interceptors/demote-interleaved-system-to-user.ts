import type { MessagesInterceptor } from './types.ts';

// Workaround for upstreams (e.g. DeepSeek-R1) that reject `role: 'system'`
// after the first non-system message. Anthropic Messages carries the
// conceptually-first system slot on the top-level `payload.system` field;
// any inline message with `role: 'system'` is therefore by definition
// interleaved, and gets demoted to `role: 'user'` with content preserved.
export const demoteInterleavedSystemToUser: MessagesInterceptor = (ctx, _gatewayCtx, run) => {
  if (!ctx.candidate.model.enabledFlags.has('demote-interleaved-system-to-user')) return run();

  const { messages } = ctx.payload;
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role === 'system') {
      messages[i] = { role: 'user', content: message.content };
    }
  }

  return run();
};
