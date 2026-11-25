import { defineStage } from './facts.ts';
import { ANTHROPIC_MESSAGES_FALLBACK_MAX_TOKENS, type AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import type { ProviderModelFact } from '@floway-dev/provider';

export const backfillRequiredFields = defineStage({
  name: 'claude-code.anthropic-messages.backfill-required-fields',
  through: {
    request: { needs: ['request.anthropicMessages', 'request.claudeCodeShaped', 'provider.model'], provides: ['request.anthropicMessages'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    if (facts['request.claudeCodeShaped']) return await scope.next(facts);
    const payload = facts['request.anthropicMessages'];
    return await scope.next({ ...facts, 'request.anthropicMessages': withRequiredFields(payload, facts['provider.model']) });
  },
});

// Real Claude Code always sends `max_tokens` and `temperature` on every
// request body. Anthropic's `/v1/messages` requires `max_tokens` and 422s
// without it; `temperature` is technically optional upstream, but its
// absence is a CC-shape fingerprint failure that the plan-billing detector
// keys on. Third-party callers (cline, aider, custom integrations) routinely
// omit one or both, expecting the gateway to backfill.
//
// Sub2api unconditionally backfills
// both: `max_tokens` to 128000 and `temperature` to 1. We mirror the same
// unconditional fill but cap `max_tokens` to the model's advertised output
// limit when present (`limits.max_output_tokens`), falling back to the
// gateway-wide ANTHROPIC_MESSAGES_FALLBACK_MAX_TOKENS (32768). The fallback
// avoids prematurely stopping modern Claude responses when the client sends
// no cap; sub2api's hardcoded 128000 ignores per-model output limits which we
// don't want to reproduce.
// https://github.com/Wei-Shaw/sub2api/blob/4a5665da5b2c6b83c4597844ea6e573746c821b1/backend/internal/service/gateway_service.go#L1301-L1314
//
// Positioned at the head of the chain so the rest of the re-mimicry steps
// see a fully-formed payload. Caller-supplied values are never overwritten.
export const withRequiredFields = (payload: AnthropicMessagesPayload, model: ProviderModelFact): AnthropicMessagesPayload => ({
  ...payload,
  max_tokens: payload.max_tokens ?? model.limits.max_output_tokens ?? ANTHROPIC_MESSAGES_FALLBACK_MAX_TOKENS,
  temperature: payload.temperature ?? 1,
});
