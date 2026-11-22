import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import { ANTHROPIC_MESSAGES_FALLBACK_MAX_TOKENS } from '@floway-dev/protocols/anthropic-messages';
import type { ProviderModelFacts } from '@floway-dev/provider';

type MessagePayload = Omit<AnthropicMessagesPayload, 'model'>;

// Real Claude Code always sends `max_tokens` and `temperature`. Anthropic
// requires `max_tokens`, and the plan-billing detector keys on `temperature`
// being present. Third-party callers routinely omit one or both.
//
// sub2api fills both unconditionally at
// `backend/internal/service/gateway_service.go:1301-1314` on revision
// 4a5665da5b2c6b83c4597844ea6e573746c821b1. We fill both, while capping
// `max_tokens` to the advertised output limit when the catalog provides one.
// Caller-supplied values are preserved.
export const backfillRequiredFieldsPayload = <P extends MessagePayload>(
  payload: P,
  model: Pick<ProviderModelFacts, 'limits'>,
): P => {
  const maxTokens = payload.max_tokens ?? model.limits.max_output_tokens ?? ANTHROPIC_MESSAGES_FALLBACK_MAX_TOKENS;
  const temperature = payload.temperature ?? 1;
  return maxTokens === payload.max_tokens && temperature === payload.temperature
    ? payload
    : { ...payload, max_tokens: maxTokens, temperature };
};
