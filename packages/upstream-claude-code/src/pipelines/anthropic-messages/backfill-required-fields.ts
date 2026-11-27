import { defineStage } from './facts.ts';
import { ANTHROPIC_MESSAGES_FALLBACK_MAX_TOKENS } from '@floway-dev/protocols/anthropic-messages';

// Claude Code sends both fields. Use the catalog limit when the caller
// omits max_tokens so the wire request stays within the model's limit.
// https://github.com/Wei-Shaw/sub2api/blob/4a5665da5b2c6b83c4597844ea6e573746c821b1/backend/internal/service/gateway_service.go#L1301-L1314

export const backfillRequiredFields = defineStage({
  name: 'claude-code.anthropic-messages.backfill-required-fields',
  through: {
    request: { needs: ['anthropicMessages', 'claudeCode.shaped', 'model'], provides: ['anthropicMessages'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  async execute(facts, scope) {
    if (facts['claudeCode.shaped']) return await scope.next(facts);
    const payload = facts.anthropicMessages;
    return await scope.next({
      ...facts,
      anthropicMessages: {
        ...payload,
        max_tokens: payload.max_tokens ?? facts.model.limits.max_output_tokens ?? ANTHROPIC_MESSAGES_FALLBACK_MAX_TOKENS,
        temperature: payload.temperature ?? 1,
      },
    });
  },
});
