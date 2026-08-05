import type { MessagesPayload } from '@floway-dev/protocols/messages';

// Anthropic Messages express reasoning intent through three orthogonal knobs;
// every `messages-via-*` pair condenses them onto the OpenAI-canonical
// `reasoning_effort` axis with the same precedence:
//
// 1. `output_config.effort` — gateway-canonical OpenAI-style override; passes
//    through verbatim. Per-upstream enum acceptance is the target
//    interceptor's concern.
// 2. `thinking.type === 'disabled'` — emit the `'none'` sentinel.
// 3. `thinking.type === 'enabled'` / `'adaptive'` — caller asked for thinking
//    but did not pin an effort. Emit `'medium'` (the OpenAI/Azure default
//    enabled level). `budget_tokens` is a token budget rather than a
//    discrete effort level, so we deliberately do not map it onto an enum;
//    callers who need finer control set `output_config.effort` directly.
export const resolveMessagesReasoningEffort = (payload: MessagesPayload): string | undefined => {
  if (payload.output_config?.effort !== undefined) return payload.output_config.effort;
  if (payload.thinking?.type === 'disabled') return 'none';
  if (payload.thinking?.type === 'enabled' || payload.thinking?.type === 'adaptive') return 'medium';
  return undefined;
};
