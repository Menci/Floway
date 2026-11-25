import { defineStage } from './facts.ts';
import { move, transform } from '@floway-dev/pipeline';
import { ANTHROPIC_MESSAGES_FALLBACK_MAX_TOKENS, type AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';

export const backfillRequiredFields = defineStage({
  name: 'claude-code.backfill-required-fields',
  through: {
    request: {
      needs: ['request.anthropicMessages', 'request.claudeCodeShaped', 'provider.model'],
      provides: ['request.anthropicMessages'],
      consumes: [],
    },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    request: facts => facts['request.claudeCodeShaped'] ? facts : {
      ...facts,
      'request.anthropicMessages': move(fillFields(facts['request.anthropicMessages'], facts['provider.model'].limits.max_output_tokens)),
    },
  })),
});

// Claude Code supplies both fields. Bound an omitted token budget by the
// selected model's advertised maximum.
// https://github.com/Wei-Shaw/sub2api/blob/4a5665da5b2c6b83c4597844ea6e573746c821b1/backend/internal/service/gateway_service.go#L1301-L1314
export const fillFields = (payload: AnthropicMessagesPayload, maxOutputTokens: number | undefined): AnthropicMessagesPayload => ({
  ...payload,
  max_tokens: payload.max_tokens ?? maxOutputTokens ?? ANTHROPIC_MESSAGES_FALLBACK_MAX_TOKENS,
  temperature: payload.temperature ?? 1,
});
